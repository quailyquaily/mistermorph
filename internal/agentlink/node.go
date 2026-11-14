package agentlink

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const (
	defaultLeaseTimeout = 30 * time.Second
	defaultQueueTTL     = 24 * time.Hour
	dispatchInterval    = time.Second
	handlerTimeout      = 15 * time.Second
	maxRetryBackoff     = time.Minute
	// attachmentLeaseExtra is the extra time a message with files gets to cross a slow link.
	attachmentLeaseExtra = 90 * time.Second
	seenRetention        = 7 * 24 * time.Hour
	maxSeenEntries       = 10000
)

// Options configure a Node.
type Options struct {
	// StateDir is the runtime's state dir: it holds the instance ID and the queue.
	StateDir string
	Logger   *slog.Logger
	// AgentName returns the agent's display name.
	AgentName func() string
	// LeaseTimeout is how long one Console holds a message before another may deliver it.
	LeaseTimeout time.Duration
	// QueueTTL is how long a message may wait for delivery.
	QueueTTL time.Duration
	Now      func() time.Time
}

// Handler accepts a message delivered to this runtime. It returns once the message is saved or
// queued for processing. A *RejectError rejects it with that reason; another error rejects it with
// ReasonHandlerErr.
type Handler func(ctx context.Context, msg Message) error

// RejectError rejects an incoming message; the sender sees Reason.
type RejectError struct {
	Reason string
	Err    error
}

func (e *RejectError) Error() string {
	if e.Err != nil {
		return e.Reason + ": " + e.Err.Error()
	}
	return e.Reason
}

func (e *RejectError) Unwrap() error { return e.Err }

// SendResult is how a send ended, or that it is still queued.
type SendResult struct {
	MessageID string `json:"message_id"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
}

// Node is a runtime's end of Agent Link. Every Console connected to the runtime serves through
// Serve; Send queues a message until one of them delivers it.
type Node struct {
	id     string
	dir    string
	opts   Options
	logger *slog.Logger

	mu       sync.Mutex
	conns    map[*nodeConn]struct{}
	outbox   map[string]*outboxEntry
	waiters  map[string][]chan SendResult
	handler  *handlerSlot
	seen     map[string]time.Time
	inflight map[string]bool
	// replies are the sends whose reply someone is waiting for, by message ID.
	replies map[string]*replyWaiter
	// asks are the sends that may still get a reply, by message ID; see ExpectReply.
	asks     map[string]askRecord
	sessions map[string]string
	connSeq  uint64
	// files is where received attachments go; nil, the node takes none.
	files *fileInbox
	// fileMu serializes saving attachments and cleaning the inbox.
	fileMu sync.Mutex
	// inboundFiles bounds the deliveries with attachments handled at once.
	inboundFiles chan struct{}
	// queuedFileBytes is the attachment bytes in the outbox, at most maxQueuedFileBytes.
	queuedFileBytes    int64
	maxQueuedFileBytes int64
	// retryBase is the first retry delay; it doubles with each attempt.
	retryBase time.Duration
	// attachmentLeaseExtra lengthens the lease of a message with files.
	attachmentLeaseExtra time.Duration
	// noStream makes the node act as one from before streamed files: it neither announces, sends
	// nor takes them. Tests use it to stand in for an older runtime.
	noStream bool
	// streams are the messages whose files are being streamed, by message ID.
	streams map[string]*outStream
	// inStreams are the streamed deliveries being received, by sender and message ID; inTransfers
	// finds them by transfer ID.
	inStreams   map[string]*inStream
	inTransfers map[string]*inStream
	// inboundReserved is the inbox bytes the unfinished streamed deliveries reserved.
	inboundReserved int64
	// inlineDispatchBytes is the queued file bytes read back into memory for inline sends.
	inlineDispatchBytes int64
	// queuing are the messages whose files are being copied into the queue, by message ID.
	queuing map[string]bool

	notifyMu    sync.Mutex
	listeners   map[int]func([]Peer)
	nextListen  int
	lastPeers   []Peer
	kick        chan struct{}
	stop        context.CancelFunc
	dispatchers sync.WaitGroup
}

type handlerSlot struct{ handle Handler }

type nodeConn struct {
	seq    uint64
	conn   Conn
	ctx    context.Context
	cancel context.CancelFunc
	out    chan Frame
	roster map[string]Peer
	// window holds a slot for each streamed chunk sent on the connection and not yet acknowledged.
	window chan struct{}
	// name and capabilities are what the hello last sent to this Console said.
	helloMu      sync.Mutex
	name         string
	capabilities []string
}

func (c *nodeConn) send(frame Frame) bool {
	select {
	case <-c.ctx.Done():
		return false
	default:
	}
	select {
	case c.out <- frame:
		return true
	case <-c.ctx.Done():
		return false
	default:
		// The Console stopped reading; drop the connection rather than block the node.
		c.cancel()
		return false
	}
}

type outboxEntry struct {
	Message   Message   `json:"message"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`

	lease      *nodeConn
	leaseID    string
	leaseUntil time.Time
	attempts   int
	notBefore  time.Time
	// inlineBytes is the file bytes read into memory for the current lease.
	inlineBytes int64
}

// NewNode opens the node for opts.StateDir, loading its instance ID and any queued messages.
func NewNode(opts Options) (*Node, error) {
	id, err := LoadOrCreateInstanceID(opts.StateDir)
	if err != nil {
		return nil, err
	}
	if opts.LeaseTimeout <= 0 {
		opts.LeaseTimeout = defaultLeaseTimeout
	}
	if opts.QueueTTL <= 0 {
		opts.QueueTTL = defaultQueueTTL
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	n := &Node{
		id:        id,
		dir:       filepath.Join(filepath.Clean(strings.TrimSpace(opts.StateDir)), "agentlink"),
		opts:      opts,
		logger:    logger.With("component", "agentlink"),
		conns:     make(map[*nodeConn]struct{}),
		outbox:    make(map[string]*outboxEntry),
		waiters:   make(map[string][]chan SendResult),
		seen:      make(map[string]time.Time),
		inflight:  make(map[string]bool),
		replies:   make(map[string]*replyWaiter),
		asks:      make(map[string]askRecord),
		sessions:  make(map[string]string),
		listeners: make(map[int]func([]Peer)),
		kick:      make(chan struct{}, 1),
		retryBase: time.Second,

		attachmentLeaseExtra: attachmentLeaseExtra,
		maxQueuedFileBytes:   maxQueuedAttachmentBytes,

		inboundFiles: make(chan struct{}, maxInboundAttachmentDeliveries),
		streams:      make(map[string]*outStream),
		inStreams:    make(map[string]*inStream),
		inTransfers:  make(map[string]*inStream),
		queuing:      make(map[string]bool),
	}
	if err := n.loadOutbox(); err != nil {
		return nil, err
	}
	// Copies of answers' files wait there only while their task runs in this process.
	_ = os.RemoveAll(n.ReplyFilesDir())
	if err := n.loadSeen(); err != nil {
		return nil, err
	}
	n.loadAsks()
	ctx, cancel := context.WithCancel(context.Background())
	n.stop = cancel
	n.dispatchers.Add(1)
	go n.dispatchLoop(ctx)
	return n, nil
}

// InstanceID is this runtime's instance ID.
func (n *Node) InstanceID() string { return n.id }

// Close stops delivery. Queued messages stay on disk.
func (n *Node) Close() {
	if n == nil || n.stop == nil {
		return
	}
	n.stop()
	n.dispatchers.Wait()
	n.mu.Lock()
	for c := range n.conns {
		c.cancel()
	}
	for _, entry := range n.outbox {
		n.clearLeaseLocked(entry)
	}
	n.mu.Unlock()
	n.closeInStreams()
}

func (n *Node) agentName() string {
	if n.opts.AgentName == nil {
		return ""
	}
	return strings.TrimSpace(n.opts.AgentName())
}

// SetHandler makes h receive delivered messages until the returned function is called. Without a
// handler, deliveries are rejected.
func (n *Node) SetHandler(h Handler) (restore func()) {
	slot := &handlerSlot{handle: h}
	n.mu.Lock()
	previous := n.handler
	n.handler = slot
	n.mu.Unlock()
	return func() {
		n.mu.Lock()
		if n.handler == slot {
			n.handler = previous
		}
		n.mu.Unlock()
	}
}

// HasHandler reports whether a handler receives delivered messages now.
func (n *Node) HasHandler() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.handler != nil && n.handler.handle != nil
}

// Peers returns every agent a connected Console reaches, sorted by instance ID.
func (n *Node) Peers() []Peer {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.peersLocked()
}

// Reachable reports whether a connected Console reaches instanceID.
func (n *Node) Reachable(instanceID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.reachableLocked(instanceID)
}

func (n *Node) reachableLocked(instanceID string) bool {
	for c := range n.conns {
		if _, ok := c.roster[instanceID]; ok {
			return true
		}
	}
	return false
}

// SupportsFiles reports whether a connected Console carries files to instanceID, which takes them.
func (n *Node) SupportsFiles(instanceID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.supportsFilesLocked(strings.TrimSpace(instanceID))
}

func (n *Node) supportsFilesLocked(instanceID string) bool {
	for c := range n.conns {
		if peer, ok := c.roster[instanceID]; ok && hasCapability(peer.Capabilities, CapabilityFiles) {
			return true
		}
	}
	return false
}

// capabilities is what the node's hello says it supports.
func (n *Node) capabilities() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	switch {
	case n.files == nil:
		return nil
	case n.noStream:
		return []string{CapabilityFiles}
	default:
		return []string{CapabilityFiles, CapabilityFilesStream}
	}
}

// announce tells every connected Console about a change of capabilities.
func (n *Node) announce() {
	n.mu.Lock()
	conns := make([]*nodeConn, 0, len(n.conns))
	for c := range n.conns {
		conns = append(conns, c)
	}
	n.mu.Unlock()
	for _, c := range conns {
		n.sendHelloIfChanged(c)
	}
}

// sendHelloIfChanged sends c a hello when the agent's name or capabilities changed since the last.
func (n *Node) sendHelloIfChanged(c *nodeConn) {
	name, caps := n.agentName(), n.capabilities()
	c.helloMu.Lock()
	defer c.helloMu.Unlock()
	if name == c.name && reflect.DeepEqual(caps, c.capabilities) {
		return
	}
	c.name, c.capabilities = name, caps
	c.send(Frame{Type: FrameHello, InstanceID: n.id, AgentName: name, Capabilities: caps})
}

func (n *Node) peersLocked() []Peer {
	merged := make(map[string]Peer)
	for c := range n.conns {
		for id, peer := range c.roster {
			existing, ok := merged[id]
			if !ok {
				merged[id] = peer
				continue
			}
			if existing.AgentName == "" {
				existing.AgentName = peer.AgentName
			}
			existing.Capabilities = knownCapabilities(append(append([]string(nil), existing.Capabilities...), peer.Capabilities...))
			merged[id] = existing
		}
	}
	out := make([]Peer, 0, len(merged))
	for _, peer := range merged {
		out = append(out, peer)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstanceID < out[j].InstanceID })
	return out
}

// Subscribe calls fn with the reachable agents now and whenever they change, until the returned
// function is called. Calls are serialized.
func (n *Node) Subscribe(fn func([]Peer)) (cancel func()) {
	n.notifyMu.Lock()
	id := n.nextListen
	n.nextListen++
	n.listeners[id] = fn
	n.notifyMu.Unlock()
	fn(n.Peers())
	return func() {
		n.notifyMu.Lock()
		delete(n.listeners, id)
		n.notifyMu.Unlock()
	}
}

func (n *Node) notifyPeers() {
	n.notifyMu.Lock()
	defer n.notifyMu.Unlock()
	peers := n.Peers()
	if reflect.DeepEqual(peers, n.lastPeers) {
		return
	}
	n.lastPeers = peers
	for _, fn := range n.listeners {
		fn(append([]Peer(nil), peers...))
	}
}

// Send queues a message to the agent with instance ID to and waits up to wait for it to be
// delivered. A message not delivered by then stays queued, and the result says so.
func (n *Node) Send(ctx context.Context, to string, envelope busruntime.MessageEnvelope, hop int, wait time.Duration) (SendResult, error) {
	return n.SendWithAttachments(ctx, to, envelope, nil, hop, wait)
}

// SendWithAttachments is Send for a message that carries files; its text may then be empty. Each
// attachment has its bytes in Data or names a file in Source (see OpenAttachmentFile); the files
// are copied into the queue and checked against their size and SHA-256 first. It returns
// ErrFilesUnsupported at once when the agent is reachable but nothing carries files to it,
// ErrFileTooLarge when the files are over the limit of the route to it (see FileLimit), and
// ErrFileQueueFull when the outbox holds too many file bytes already. A queued message that finds
// only Consoles or a peer without CapabilityFiles, or, with more than MaxAttachmentBytes, without
// CapabilityFilesStream, is rejected with ReasonFilesUnsupported.
func (n *Node) SendWithAttachments(ctx context.Context, to string, envelope busruntime.MessageEnvelope, attachments []Attachment, hop int, wait time.Duration) (SendResult, error) {
	to = strings.TrimSpace(to)
	if to == n.id {
		return SendResult{}, fmt.Errorf("agent link cannot send to itself")
	}
	if hop < 1 {
		hop = 1
	}
	envelope.MessageID = strings.TrimSpace(envelope.MessageID)
	if envelope.MessageID == "" {
		envelope.MessageID = "msg_" + uuid.NewString()
	}
	if strings.TrimSpace(envelope.SentAt) == "" {
		envelope.SentAt = n.opts.Now().UTC().Format(time.RFC3339)
	}
	msg := Message{MessageID: envelope.MessageID, From: n.id, To: to, Hop: hop, Envelope: envelope}
	sources := append([]Attachment(nil), attachments...)
	if len(sources) > 0 {
		msg.Attachments = make([]Attachment, len(sources))
		for i, a := range sources {
			if n.noStream && a.Data == nil && a.Source != "" {
				// An older runtime holds the bytes in its queue entry.
				read, err := ReadAttachmentFile(a.Source, a.Filename, a.Size, a.SHA256)
				if err != nil {
					return SendResult{}, err
				}
				a.Data = read.Data
			}
			a.Path, a.Ref, a.Source = "", "", ""
			if n.noStream {
				a.TransferID = ""
			} else {
				a.Data, a.TransferID = nil, newTransferID()
			}
			msg.Attachments[i] = a
		}
	}
	if err := msg.Validate(); err != nil {
		limit := streamFileLimit
		if n.noStream {
			limit = inlineFileLimit
		}
		var already int64
		for _, a := range msg.Attachments {
			if limitErr := limit.Check(a.Size, already); limitErr != nil {
				return SendResult{}, limitErr
			}
			already += a.Size
		}
		return SendResult{}, err
	}
	fileBytes := attachmentBytes(msg.Attachments)
	if len(msg.Attachments) > 0 {
		encoded, err := json.Marshal(msg)
		if err != nil {
			return SendResult{}, err
		}
		size := len(encoded)
		if streamed(msg.Attachments) && fileBytes <= MaxAttachmentBytes {
			// It may go inline, through a route that does not stream.
			size += base64.StdEncoding.EncodedLen(int(fileBytes))
		}
		if size > maxAttachmentMessageBytes {
			return SendResult{}, fmt.Errorf("message with attachments too large for Agent Link (%d bytes encoded; at most %d)", size, maxAttachmentMessageBytes)
		}
	}
	now := n.opts.Now().UTC()
	entry := &outboxEntry{Message: msg, CreatedAt: now, ExpiresAt: now.Add(n.opts.QueueTTL)}

	n.mu.Lock()
	if _, exists := n.outbox[msg.MessageID]; exists || n.queuing[msg.MessageID] {
		// Queued already, or being queued by another send of the same message, whose copies of
		// the files this one must not replace.
		n.mu.Unlock()
		return SendResult{MessageID: msg.MessageID, Status: StatusQueued}, nil
	}
	if len(msg.Attachments) > 0 {
		if n.reachableLocked(to) && !n.supportsFilesLocked(to) {
			n.mu.Unlock()
			return SendResult{}, fmt.Errorf("%w: the agent's runtime or the Console that reaches it is too old to take files", ErrFilesUnsupported)
		}
		limit := n.fileLimitLocked(to)
		var already int64
		for _, a := range msg.Attachments {
			if err := limit.Check(a.Size, already); err != nil {
				n.mu.Unlock()
				return SendResult{}, err
			}
			already += a.Size
		}
		if n.queuedFileBytes+fileBytes > n.maxQueuedFileBytes {
			n.mu.Unlock()
			return SendResult{}, fmt.Errorf("%w: %d bytes of files already wait for delivery (at most %d); try again later", ErrFileQueueFull, n.queuedFileBytes, n.maxQueuedFileBytes)
		}
	}
	// Reserve the queue's room, and the message ID, while the files are copied.
	n.queuedFileBytes += fileBytes
	n.queuing[msg.MessageID] = true
	n.mu.Unlock()
	release := func() {
		n.mu.Lock()
		n.queuedFileBytes -= fileBytes
		delete(n.queuing, msg.MessageID)
		n.mu.Unlock()
	}
	if streamed(msg.Attachments) {
		if err := n.writeSnapshots(msg.MessageID, sources); err != nil {
			release()
			return SendResult{}, err
		}
	}
	n.mu.Lock()
	if err := n.writeEntry(entry); err != nil {
		n.mu.Unlock()
		if streamed(msg.Attachments) {
			_ = os.RemoveAll(n.filesDir(msg.MessageID))
		}
		release()
		return SendResult{}, err
	}
	delete(n.queuing, msg.MessageID)
	n.outbox[msg.MessageID] = entry
	result := make(chan SendResult, 1)
	n.waiters[msg.MessageID] = append(n.waiters[msg.MessageID], result)
	n.mu.Unlock()
	n.wake()

	queued := SendResult{MessageID: msg.MessageID, Status: StatusQueued}
	if wait <= 0 {
		n.dropWaiter(msg.MessageID, result)
		return queued, nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case res := <-result:
		return res, nil
	case <-timer.C:
	case <-ctx.Done():
	}
	n.dropWaiter(msg.MessageID, result)
	select {
	case res := <-result:
		return res, nil
	default:
		return queued, nil
	}
}

func (n *Node) dropWaiter(messageID string, result chan SendResult) {
	n.mu.Lock()
	defer n.mu.Unlock()
	list := n.waiters[messageID]
	for i, item := range list {
		if item == result {
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(n.waiters, messageID)
	} else {
		n.waiters[messageID] = list
	}
}

func (n *Node) wake() {
	select {
	case n.kick <- struct{}{}:
	default:
	}
}

// Serve runs one Console's connection until it closes or ctx ends.
func (n *Node) Serve(ctx context.Context, conn Conn) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := &nodeConn{conn: conn, ctx: ctx, cancel: cancel, out: make(chan Frame, 256), roster: map[string]Peer{}, window: make(chan struct{}, streamWindow)}
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-c.out:
				if err := conn.WriteFrame(ctx, frame); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	c.name, c.capabilities = n.agentName(), n.capabilities()
	c.send(Frame{Type: FrameHello, InstanceID: n.id, AgentName: c.name, Capabilities: c.capabilities})
	n.mu.Lock()
	n.connSeq++
	c.seq = n.connSeq
	n.conns[c] = struct{}{}
	n.mu.Unlock()
	defer n.removeConn(c)

	for {
		frame, err := conn.ReadFrame(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		switch frame.Type {
		case FrameRoster:
			n.setRoster(c, frame.Agents)
		case FrameSendResult:
			n.handleSendResult(c, frame)
		case FrameDeliver:
			go n.handleDeliver(c, frame)
		case FrameChunk:
			// In order, on the reading goroutine: chunks must reach the file as they came.
			n.handleChunk(c, frame)
		case FrameChunkAck:
			n.handleChunkAck(c, frame)
		case FrameTransferAbort:
			n.handleTransferAbort(c, frame)
		case FramePing:
			c.send(Frame{Type: FramePong})
			// Tell the Console about a rename without reconnecting.
			n.sendHelloIfChanged(c)
		case FramePong:
		case FrameError:
			return fmt.Errorf("agent link console error: %s", strings.TrimSpace(frame.Reason))
		default:
			n.logger.Debug("agentlink_unknown_frame", "type", frame.Type)
		}
	}
}

func (n *Node) removeConn(c *nodeConn) {
	c.cancel()
	n.mu.Lock()
	delete(n.conns, c)
	for _, entry := range n.outbox {
		if entry.lease == c {
			n.clearLeaseLocked(entry)
		}
	}
	n.mu.Unlock()
	n.parkInStreams(c)
	n.notifyPeers()
	n.wake()
}

func (n *Node) setRoster(c *nodeConn, agents []Peer) {
	roster := make(map[string]Peer, len(agents))
	for _, peer := range agents {
		peer.InstanceID = strings.TrimSpace(peer.InstanceID)
		peer.AgentName = strings.TrimSpace(peer.AgentName)
		peer.Capabilities = knownCapabilities(peer.Capabilities)
		if peer.InstanceID == n.id || !ValidInstanceID(peer.InstanceID) {
			continue
		}
		roster[peer.InstanceID] = peer
	}
	n.mu.Lock()
	if _, ok := n.conns[c]; ok {
		c.roster = roster
	}
	n.mu.Unlock()
	n.notifyPeers()
	n.wake()
}

func (n *Node) handleSendResult(c *nodeConn, frame Frame) {
	id := strings.TrimSpace(frame.MessageID)
	n.mu.Lock()
	entry := n.outbox[id]
	if entry == nil || entry.lease != c || entry.leaseID != frame.LeaseID {
		n.mu.Unlock()
		return
	}
	switch frame.Status {
	case StatusDelivered, StatusRejected:
		n.mu.Unlock()
		n.finish(id, SendResult{MessageID: id, Status: frame.Status, Reason: strings.TrimSpace(frame.Reason)})
		return
	default:
		n.clearLeaseLocked(entry)
		n.backoffLocked(entry)
		n.mu.Unlock()
		n.wake()
	}
}

// clearLeaseLocked ends the current delivery attempt of entry: its stream stops and the bytes it
// read into memory are released.
func (n *Node) clearLeaseLocked(entry *outboxEntry) {
	entry.lease = nil
	entry.leaseID = ""
	n.inlineDispatchBytes -= entry.inlineBytes
	entry.inlineBytes = 0
	if s := n.streams[entry.Message.MessageID]; s != nil {
		delete(n.streams, entry.Message.MessageID)
		s.stop()
	}
}

// handleChunkAck passes an acknowledgement of streamed bytes to the stream of the current lease, and
// renews the lease: the transfer is making progress.
func (n *Node) handleChunkAck(c *nodeConn, frame Frame) {
	id := strings.TrimSpace(frame.MessageID)
	n.mu.Lock()
	entry := n.outbox[id]
	s := n.streams[id]
	if entry == nil || s == nil || entry.lease != c || entry.leaseID != frame.LeaseID || s.leaseID != frame.LeaseID || s.attempt != frame.Attempt {
		n.mu.Unlock()
		return
	}
	entry.leaseUntil = n.opts.Now().Add(n.opts.LeaseTimeout + streamLeaseIdle)
	n.mu.Unlock()
	s.ack(frame.TransferID, frame.Offset)
}

// Transfers reports the streamed files being sent and received.
func (n *Node) Transfers() []TransferStatus {
	n.mu.Lock()
	outs := make([]*outStream, 0, len(n.streams))
	for _, s := range n.streams {
		outs = append(outs, s)
	}
	ins := make([]*inStream, 0, len(n.inStreams))
	for _, s := range n.inStreams {
		ins = append(ins, s)
	}
	n.mu.Unlock()
	var out []TransferStatus
	for _, s := range outs {
		out = append(out, s.status()...)
	}
	for _, s := range ins {
		out = append(out, s.status()...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].MessageID != out[j].MessageID {
			return out[i].MessageID < out[j].MessageID
		}
		return out[i].TransferID < out[j].TransferID
	})
	return out
}

func (n *Node) backoffLocked(entry *outboxEntry) {
	entry.attempts++
	delay := n.retryBase << min(entry.attempts, 6)
	if delay > maxRetryBackoff {
		delay = maxRetryBackoff
	}
	entry.notBefore = n.opts.Now().Add(delay)
}

func (n *Node) finish(id string, result SendResult) {
	n.mu.Lock()
	entry := n.outbox[id]
	delete(n.outbox, id)
	waiters := n.waiters[id]
	delete(n.waiters, id)
	if entry != nil {
		n.queuedFileBytes -= attachmentBytes(entry.Message.Attachments)
		n.clearLeaseLocked(entry)
	}
	n.mu.Unlock()
	if entry == nil {
		return
	}
	if err := os.Remove(n.entryPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		n.logger.Warn("agentlink_outbox_remove_error", "message_id", id, "error", err.Error())
	}
	if streamed(entry.Message.Attachments) {
		if err := os.RemoveAll(n.filesDir(id)); err != nil {
			n.logger.Warn("agentlink_outbox_remove_error", "message_id", id, "error", err.Error())
		}
	}
	level := slog.LevelInfo
	if result.Status != StatusDelivered {
		level = slog.LevelWarn
	}
	n.logger.Log(context.Background(), level, "agentlink_send_finished", "message_id", id, "to", entry.Message.To, "status", result.Status, "reason", result.Reason)
	for _, waiter := range waiters {
		waiter <- result
	}
}

func (n *Node) handleDeliver(c *nodeConn, frame Frame) {
	reply := func(status, reason string) {
		c.send(Frame{Type: FrameDeliverResult, MessageID: frame.MessageID, Attempt: frame.Attempt, Status: status, Reason: reason})
	}
	if frame.Message == nil {
		reply(StatusRejected, ReasonInvalid)
		return
	}
	msg := *frame.Message
	frame.MessageID = msg.MessageID
	if err := msg.Validate(); err != nil || msg.To != n.id {
		reply(StatusRejected, ReasonInvalid)
		return
	}
	if streamed(msg.Attachments) {
		n.handleStreamDeliver(c, frame.Attempt, msg, reply)
		return
	}
	withFiles := len(msg.Attachments) > 0
	n.mu.Lock()
	if _, seen := n.seen[msg.MessageID]; seen {
		n.mu.Unlock()
		reply(StatusAccepted, "")
		return
	}
	if n.inflight[msg.MessageID] {
		// Another Console is delivering the same message; let the sender retry and find it seen.
		n.mu.Unlock()
		reply(StatusUnreachable, "")
		return
	}
	inbox := n.files
	if withFiles && inbox == nil {
		n.mu.Unlock()
		reply(StatusRejected, ReasonFilesUnsupported)
		return
	}
	if !withFiles && n.takeReplyLocked(msg) {
		n.markSeenLocked(msg.MessageID)
		n.mu.Unlock()
		reply(StatusAccepted, "")
		return
	}
	// An answer to a message this runtime sent is wanted; anything else needs authorizing.
	answer := withFiles && n.replyWaitingLocked(msg)
	slot := n.handler
	if !answer && (slot == nil || slot.handle == nil) {
		n.mu.Unlock()
		reply(StatusRejected, ReasonNoHandler)
		return
	}
	n.inflight[msg.MessageID] = true
	n.mu.Unlock()

	if !withFiles {
		n.handOver(slot, msg, reply)
		return
	}
	select {
	case n.inboundFiles <- struct{}{}:
		defer func() { <-n.inboundFiles }()
	default:
		// Too many files arrive at once; the sender retries later.
		n.mu.Lock()
		delete(n.inflight, msg.MessageID)
		n.mu.Unlock()
		reply(StatusUnreachable, "")
		return
	}
	authorized := false
	if !answer {
		if err := n.authorizeFiles(inbox, msg.From); err != nil {
			n.rejectDelivery(msg, ReasonUnauthorized, err, reply)
			return
		}
		authorized = true
	}
	saved, err := n.saveAttachments(inbox, msg)
	if err != nil {
		n.rejectDelivery(msg, ReasonAttachmentStore, err, reply)
		return
	}
	msg.Attachments = saved
	n.acceptFiles(msg, inbox, authorized, reply)
}

// authorizeFiles asks the inbox's authorizer whether from may send files.
func (n *Node) authorizeFiles(inbox *fileInbox, from string) error {
	if inbox.authorize == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), handlerTimeout)
	defer cancel()
	return inbox.authorize(ctx, from)
}

// rejectDelivery ends a delivery marked in flight: its saved files go, and the sender sees reason.
func (n *Node) rejectDelivery(msg Message, reason string, err error, reply func(status, reason string)) {
	removeAttachments(msg.Attachments)
	n.mu.Lock()
	delete(n.inflight, msg.MessageID)
	n.mu.Unlock()
	if err != nil {
		n.logger.Warn("agentlink_deliver_rejected", "message_id", msg.MessageID, "from", msg.From, "reason", reason, "error", err.Error())
	}
	reply(StatusRejected, reason)
}

// acceptFiles ends a delivery marked in flight whose files are saved: the send waiting for it as an
// answer takes it, or else the handler, once the sender is authorized.
func (n *Node) acceptFiles(msg Message, inbox *fileInbox, authorized bool, reply func(status, reason string)) {
	n.mu.Lock()
	if n.takeReplyLocked(msg) {
		delete(n.inflight, msg.MessageID)
		n.markSeenLocked(msg.MessageID)
		n.mu.Unlock()
		n.logger.Info("agentlink_attachments_received", "message_id", msg.MessageID, "from", msg.From, "count", len(msg.Attachments))
		reply(StatusAccepted, "")
		return
	}
	// The answer's waiter stopped waiting, or this is no answer; the handler takes it.
	slot := n.handler
	n.mu.Unlock()
	if slot == nil || slot.handle == nil {
		n.rejectDelivery(msg, ReasonNoHandler, nil, reply)
		return
	}
	if !authorized {
		if err := n.authorizeFiles(inbox, msg.From); err != nil {
			n.rejectDelivery(msg, ReasonUnauthorized, err, reply)
			return
		}
	}
	n.handOver(slot, msg, reply)
}

// handOver gives a delivery marked in flight to the handler.
func (n *Node) handOver(slot *handlerSlot, msg Message, reply func(status, reason string)) {
	ctx, cancel := context.WithTimeout(context.Background(), handlerTimeout)
	defer cancel()
	if err := slot.handle(ctx, msg); err != nil {
		var rejectErr *RejectError
		reason := ReasonHandlerErr
		if errors.As(err, &rejectErr) && strings.TrimSpace(rejectErr.Reason) != "" {
			reason = rejectErr.Reason
		}
		n.rejectDelivery(msg, reason, err, reply)
		return
	}
	n.mu.Lock()
	delete(n.inflight, msg.MessageID)
	n.markSeenLocked(msg.MessageID)
	n.mu.Unlock()
	if len(msg.Attachments) > 0 {
		n.logger.Info("agentlink_attachments_received", "message_id", msg.MessageID, "from", msg.From, "count", len(msg.Attachments))
	}
	reply(StatusAccepted, "")
}

func (n *Node) markSeenLocked(messageID string) {
	n.seen[messageID] = n.opts.Now().UTC()
	n.saveSeenLocked()
}

func (n *Node) dispatchLoop(ctx context.Context) {
	defer n.dispatchers.Done()
	ticker := time.NewTicker(dispatchInterval)
	defer ticker.Stop()
	for {
		n.dispatch()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-n.kick:
		}
	}
}

func (n *Node) dispatch() {
	now := n.opts.Now()
	var expired, unsupported, broken []string
	var started []*outStream
	n.mu.Lock()
	entries := make([]*outboxEntry, 0, len(n.outbox))
	for _, entry := range n.outbox {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].CreatedAt.Before(entries[j].CreatedAt) })
	for _, entry := range entries {
		if !now.Before(entry.ExpiresAt) {
			expired = append(expired, entry.Message.MessageID)
			continue
		}
		if entry.lease != nil {
			if now.Before(entry.leaseUntil) {
				continue
			}
			n.clearLeaseLocked(entry)
			n.backoffLocked(entry)
		}
		if now.Before(entry.notBefore) {
			continue
		}
		attachments := entry.Message.Attachments
		withFiles := len(attachments) > 0
		streamForm := streamed(attachments)
		fileBytes := attachmentBytes(attachments)
		// A queued streamed message small enough goes inline through a route that does not
		// stream; one queued by an older version is inline already.
		inlineOK := withFiles && (!streamForm || fileBytes <= MaxAttachmentBytes)
		reachable := false
		var plain, streams, inline []*nodeConn
		for c := range n.conns {
			peer, ok := c.roster[entry.Message.To]
			if !ok {
				continue
			}
			reachable = true
			switch {
			case !withFiles:
				plain = append(plain, c)
			// Files go only through a Console that carries them to a peer that takes them; they
			// are streamed when both stream.
			case streamForm && !n.noStream && hasCapability(peer.Capabilities, CapabilityFilesStream):
				streams = append(streams, c)
			case inlineOK && hasCapability(peer.Capabilities, CapabilityFiles):
				inline = append(inline, c)
			}
		}
		candidates := plain
		switch {
		case len(streams) > 0:
			candidates = streams
		case len(inline) > 0:
			candidates = inline
		}
		if len(candidates) == 0 {
			if reachable && withFiles {
				unsupported = append(unsupported, entry.Message.MessageID)
			}
			continue
		}
		// Spread retries over the Consoles that reach the target.
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].seq < candidates[j].seq })
		c := candidates[entry.attempts%len(candidates)]
		msg := entry.Message
		leaseID := uuid.NewString()
		var attempt string
		var stream *outStream
		var loaded int64
		switch {
		case len(streams) > 0:
			attempt = newAttemptID()
			stream = n.newOutStream(c, msg, leaseID, attempt)
		case streamForm && withFiles:
			if n.inlineDispatchBytes+fileBytes > maxInlineDispatchBytes {
				// Enough files are in memory already; this one waits for the next round.
				continue
			}
			inlined, err := n.inlineMessage(entry)
			if err != nil {
				n.logger.Warn("agentlink_outbox_file_error", "message_id", msg.MessageID, "error", err.Error())
				broken = append(broken, msg.MessageID)
				continue
			}
			msg, loaded = inlined, fileBytes
		}
		if !c.send(Frame{Type: FrameSend, LeaseID: leaseID, Attempt: attempt, MessageID: msg.MessageID, Message: &msg}) {
			continue
		}
		entry.lease = c
		entry.leaseID = leaseID
		entry.leaseUntil = now.Add(n.opts.LeaseTimeout)
		if withFiles {
			entry.leaseUntil = entry.leaseUntil.Add(n.attachmentLeaseExtra)
		}
		entry.inlineBytes = loaded
		n.inlineDispatchBytes += loaded
		if stream != nil {
			n.streams[msg.MessageID] = stream
			started = append(started, stream)
		}
	}
	n.mu.Unlock()
	for _, s := range started {
		go s.run()
	}
	for _, id := range expired {
		n.finish(id, SendResult{MessageID: id, Status: StatusExpired})
	}
	for _, id := range unsupported {
		n.finish(id, SendResult{MessageID: id, Status: StatusRejected, Reason: ReasonFilesUnsupported})
	}
	for _, id := range broken {
		n.finish(id, SendResult{MessageID: id, Status: StatusRejected, Reason: ReasonAttachmentStore})
	}
	n.sweepInStreams()
}

func (n *Node) outboxDir() string { return filepath.Join(n.dir, "outbox") }

func (n *Node) entryPath(messageID string) string {
	return filepath.Join(n.outboxDir(), safeFileName(messageID)+".json")
}

func (n *Node) writeEntry(entry *outboxEntry) error {
	return fsstore.WriteJSONAtomic(n.entryPath(entry.Message.MessageID), entry, fsstore.FileOptions{})
}

func (n *Node) loadOutbox() error {
	items, err := os.ReadDir(n.outboxDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(item.Name(), ".json") {
			continue
		}
		var entry outboxEntry
		path := filepath.Join(n.outboxDir(), item.Name())
		ok, err := fsstore.ReadJSON(path, &entry)
		if err != nil || !ok || entry.Message.Validate() != nil || entry.Message.From != n.id {
			n.logger.Warn("agentlink_outbox_entry_skipped", "path", path)
			continue
		}
		if streamed(entry.Message.Attachments) && !n.checkSnapshots(entry.Message) {
			n.logger.Warn("agentlink_outbox_entry_skipped", "path", path, "reason", "queued files missing")
			continue
		}
		n.outbox[entry.Message.MessageID] = &entry
		n.queuedFileBytes += attachmentBytes(entry.Message.Attachments)
	}
	n.removeOrphanSnapshots()
	return nil
}

type seenFile struct {
	Messages map[string]time.Time `json:"messages"`
}

func (n *Node) seenPath() string { return filepath.Join(n.dir, "seen.json") }

func (n *Node) loadSeen() error {
	var file seenFile
	if _, err := fsstore.ReadJSON(n.seenPath(), &file); err != nil {
		n.logger.Warn("agentlink_seen_load_error", "error", err.Error())
		return nil
	}
	for id, at := range file.Messages {
		n.seen[id] = at
	}
	return nil
}

func (n *Node) saveSeenLocked() {
	cutoff := n.opts.Now().Add(-seenRetention)
	for id, at := range n.seen {
		if at.Before(cutoff) {
			delete(n.seen, id)
		}
	}
	if len(n.seen) > maxSeenEntries {
		ids := make([]string, 0, len(n.seen))
		for id := range n.seen {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return n.seen[ids[i]].Before(n.seen[ids[j]]) })
		for _, id := range ids[:len(ids)-maxSeenEntries] {
			delete(n.seen, id)
		}
	}
	if err := fsstore.WriteJSONAtomic(n.seenPath(), seenFile{Messages: n.seen}, fsstore.FileOptions{}); err != nil {
		n.logger.Warn("agentlink_seen_save_error", "error", err.Error())
	}
}

func safeFileName(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

var shared = struct {
	sync.Mutex
	nodes map[string]*Node
}{nodes: map[string]*Node{}}

// Shared returns the process's node for opts.StateDir, opening it on first use. Later calls return
// the same node and ignore the other options.
func Shared(opts Options) (*Node, error) {
	key := filepath.Clean(strings.TrimSpace(opts.StateDir))
	if strings.TrimSpace(opts.StateDir) == "" {
		return nil, fmt.Errorf("state dir is required")
	}
	shared.Lock()
	defer shared.Unlock()
	if node := shared.nodes[key]; node != nil {
		return node, nil
	}
	node, err := NewNode(opts)
	if err != nil {
		return nil, err
	}
	shared.nodes[key] = node
	return node, nil
}

// Lookup returns the process's node for stateDir, if one is open.
func Lookup(stateDir string) (*Node, bool) {
	key := filepath.Clean(strings.TrimSpace(stateDir))
	shared.Lock()
	defer shared.Unlock()
	node := shared.nodes[key]
	return node, node != nil
}
