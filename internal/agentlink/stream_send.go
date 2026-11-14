package agentlink

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// The sending side of streamed files. SendWithAttachments copies each file into the queue's own
// storage (state_dir/agentlink/outbox-files/<message>/<index>), so later changes to the source do
// not matter; the queue entry keeps only the metadata. A delivery through a Console that streams
// to the peer sends the metadata, waits for the receiver's first acknowledgement of each file (the
// offset it already holds), then reads the copy chunk by chunk.

// FileLimit is how many file bytes a message to a peer may carry on the route to it.
type FileLimit struct {
	// PerFile and PerMessage bound one file and all files of a message.
	PerFile, PerMessage int64
	// Streamed is whether the route streams files. A route that does not carries
	// MaxAttachmentBytes in all.
	Streamed bool
}

// Check returns an error wrapping ErrFileTooLarge when a file of size bytes does not fit, with
// already bytes of files in the same message, and says which limit applied.
func (l FileLimit) Check(size, already int64) error {
	switch {
	case size > l.PerFile && l.Streamed:
		return fmt.Errorf("%w (%d bytes; at most %d per file when files are streamed)", ErrFileTooLarge, size, l.PerFile)
	case size > l.PerFile:
		return fmt.Errorf("%w (%d bytes; at most %d: the agent's runtime or the Console that reaches it does not stream files)", ErrFileTooLarge, size, l.PerFile)
	case already+size > l.PerMessage && l.Streamed:
		return fmt.Errorf("%w (%d bytes of files in one message; at most %d when files are streamed)", ErrFileTooLarge, already+size, l.PerMessage)
	case already+size > l.PerMessage:
		return fmt.Errorf("%w (%d bytes of files in one message; at most %d: the agent's runtime or the Console that reaches it does not stream files)", ErrFileTooLarge, already+size, l.PerMessage)
	}
	return nil
}

var (
	streamFileLimit = FileLimit{PerFile: MaxStreamAttachmentBytes, PerMessage: MaxStreamMessageBytes, Streamed: true}
	inlineFileLimit = FileLimit{PerFile: MaxAttachmentBytes, PerMessage: MaxAttachmentBytes}
)

// FileLimit returns the limit of files to instanceID: the streamed limit when a connected Console
// streams files to it, or when none reaches it now (the message waits, and is refused with
// ReasonFilesUnsupported if it then finds only a route that does not stream and it is over
// MaxAttachmentBytes); the inline limit otherwise.
func (n *Node) FileLimit(instanceID string) FileLimit {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.fileLimitLocked(strings.TrimSpace(instanceID))
}

func (n *Node) fileLimitLocked(instanceID string) FileLimit {
	if n.noStream {
		return inlineFileLimit
	}
	if !n.reachableLocked(instanceID) || n.supportsStreamLocked(instanceID) {
		return streamFileLimit
	}
	return inlineFileLimit
}

// SupportsFileStream reports whether a connected Console streams files to instanceID.
func (n *Node) SupportsFileStream(instanceID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return !n.noStream && n.supportsStreamLocked(strings.TrimSpace(instanceID))
}

func (n *Node) supportsStreamLocked(instanceID string) bool {
	for c := range n.conns {
		if peer, ok := c.roster[instanceID]; ok && hasCapability(peer.Capabilities, CapabilityFilesStream) {
			return true
		}
	}
	return false
}

func (n *Node) filesRoot() string { return filepath.Join(n.dir, "outbox-files") }

// filesDir holds the queued copies of a message's files.
func (n *Node) filesDir(messageID string) string {
	return filepath.Join(n.filesRoot(), safeFileName(messageID))
}

func (n *Node) snapshotPath(messageID string, index int) string {
	return filepath.Join(n.filesDir(messageID), strconv.Itoa(index))
}

// writeSnapshots copies the files of a message into the queue, checking each against its size and
// SHA-256. sources are the attachments as given, with Source or Data.
func (n *Node) writeSnapshots(messageID string, sources []Attachment) error {
	dir := n.filesDir(messageID)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for i, a := range sources {
		if err := writeSnapshot(n.snapshotPath(messageID, i), a); err != nil {
			_ = os.RemoveAll(dir)
			return err
		}
	}
	return nil
}

func writeSnapshot(dst string, a Attachment) (err error) {
	var src io.Reader
	if a.Source != "" {
		f, err := os.Open(a.Source)
		if err != nil {
			return fmt.Errorf("read file: %w", err)
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return fmt.Errorf("read file: %w", err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("path is not a regular file: %s", a.Source)
		}
		if info.Size() != a.Size {
			return fmt.Errorf("file changed after it was checked: %s", a.Source)
		}
		src = f
	} else {
		if int64(len(a.Data)) != a.Size {
			return fmt.Errorf("attachment %q: size %d does not match its %d bytes", a.Filename, a.Size, len(a.Data))
		}
		src = bytes.NewReader(a.Data)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(dst)
		}
	}()
	h := sha256.New()
	written, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(src, a.Size+1))
	if err != nil {
		return fmt.Errorf("queue file: %w", err)
	}
	if written != a.Size || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(a.SHA256) {
		if a.Source != "" {
			return fmt.Errorf("file changed after it was checked: %s", a.Source)
		}
		return fmt.Errorf("attachment %q: sha256 does not match its bytes", a.Filename)
	}
	return out.Sync()
}

// checkSnapshots reports whether the queued copies of a message's files are all there.
func (n *Node) checkSnapshots(msg Message) bool {
	for i, a := range msg.Attachments {
		info, err := os.Lstat(n.snapshotPath(msg.MessageID, i))
		if err != nil || !info.Mode().IsRegular() || info.Size() != a.Size {
			return false
		}
	}
	return true
}

// removeOrphanSnapshots removes queued copies whose queue entry is gone.
func (n *Node) removeOrphanSnapshots() {
	items, err := os.ReadDir(n.filesRoot())
	if err != nil {
		return
	}
	keep := make(map[string]bool, len(n.outbox))
	for id := range n.outbox {
		keep[safeFileName(id)] = true
	}
	for _, item := range items {
		if !keep[item.Name()] {
			_ = os.RemoveAll(filepath.Join(n.filesRoot(), item.Name()))
		}
	}
}

// inlineMessage is a queued streamed message with its files read back into Data, for a route that
// does not stream. Its total is at most MaxAttachmentBytes.
func (n *Node) inlineMessage(entry *outboxEntry) (Message, error) {
	msg := entry.Message
	msg.Attachments = append([]Attachment(nil), msg.Attachments...)
	for i := range msg.Attachments {
		a := &msg.Attachments[i]
		data, err := os.ReadFile(n.snapshotPath(msg.MessageID, i))
		if err != nil {
			return Message{}, err
		}
		sum := sha256.Sum256(data)
		if int64(len(data)) != a.Size || hex.EncodeToString(sum[:]) != a.SHA256 {
			return Message{}, fmt.Errorf("queued file %q changed", a.Filename)
		}
		a.Data = data
		a.TransferID = ""
	}
	return msg, nil
}

// outStream sends the files of one leased message over one connection.
type outStream struct {
	n       *Node
	c       *nodeConn
	msg     Message
	leaseID string
	// attempt is the delivery attempt the stream's chunks belong to.
	attempt string
	files   []*outFile
	done    chan struct{}
	// wake is signalled by every acknowledgement.
	wake chan struct{}

	mu      sync.Mutex
	stopped bool
	// held is how many of the connection's window slots the stream holds.
	held int
}

type outFile struct {
	index      int
	transferID string
	filename   string
	path       string
	size       int64
	// start is the offset the receiver first acknowledged, -1 before that; sent and acked are the
	// bytes sent and acknowledged.
	start, sent, acked int64
	// ends are the end offsets of the chunks sent and not yet acknowledged.
	ends     []int64
	loggedAt int64
}

func (n *Node) newOutStream(c *nodeConn, msg Message, leaseID, attempt string) *outStream {
	s := &outStream{n: n, c: c, msg: msg, leaseID: leaseID, attempt: attempt, done: make(chan struct{}), wake: make(chan struct{}, 1)}
	for i, a := range msg.Attachments {
		s.files = append(s.files, &outFile{
			index: i, transferID: a.TransferID, filename: a.Filename, path: n.snapshotPath(msg.MessageID, i),
			size: a.Size, start: -1,
		})
	}
	return s
}

// stop ends the stream and gives its window slots back. Chunks already written may still arrive.
func (s *outStream) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	s.stopped = true
	close(s.done)
	for ; s.held > 0; s.held-- {
		<-s.c.window
	}
}

func (s *outStream) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// ack records an acknowledgement: the receiver holds offset bytes of the transfer.
func (s *outStream) ack(transferID string, offset int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	var f *outFile
	for _, candidate := range s.files {
		if candidate.transferID == transferID {
			f = candidate
		}
	}
	if f == nil {
		return
	}
	if f.start < 0 {
		if offset < 0 || offset > f.size {
			s.n.logger.Warn("agentlink_transfer_bad_ack", "message_id", s.msg.MessageID, "transfer_id", transferID, "offset", offset)
			return
		}
		f.start, f.sent, f.acked = offset, offset, offset
		f.loggedAt = offset
		s.n.logger.Info("agentlink_transfer_started", "direction", "send", "message_id", s.msg.MessageID, "to", s.msg.To,
			"transfer_id", transferID, "filename", f.filename, "size", f.size, "offset", offset)
		s.signal()
		return
	}
	if offset < f.acked || offset > f.sent {
		s.n.logger.Warn("agentlink_transfer_bad_ack", "message_id", s.msg.MessageID, "transfer_id", transferID, "offset", offset)
		return
	}
	for len(f.ends) > 0 && f.ends[0] <= offset {
		f.ends = f.ends[1:]
		s.held--
		<-s.c.window
	}
	f.acked = offset
	if offset == f.size || offset-f.loggedAt >= streamProgressStep {
		f.loggedAt = offset
		s.n.logger.Info("agentlink_transfer_progress", "direction", "send", "message_id", s.msg.MessageID, "to", s.msg.To,
			"transfer_id", transferID, "bytes", offset, "size", f.size)
	}
	s.signal()
}

// run sends the files in order, each from the offset the receiver holds, keeping at most
// streamWindow chunks unacknowledged on the connection.
func (s *outStream) run() {
	for _, f := range s.files {
		if !s.waitStart(f) {
			return
		}
		if err := s.sendFile(f); err != nil {
			s.mu.Lock()
			stopped := s.stopped
			s.mu.Unlock()
			if stopped || errors.Is(err, errStreamStopped) {
				// The delivery ended meanwhile (its copy may be gone with it).
				return
			}
			s.n.logger.Warn("agentlink_transfer_read_error", "message_id", s.msg.MessageID, "transfer_id", f.transferID, "error", err.Error())
			// The queued copy is gone or damaged; the message cannot go.
			s.n.finish(s.msg.MessageID, SendResult{MessageID: s.msg.MessageID, Status: StatusRejected, Reason: ReasonAttachmentStore})
			return
		}
	}
}

var errStreamStopped = errors.New("stream stopped")

func (s *outStream) waitStart(f *outFile) bool {
	for {
		s.mu.Lock()
		started, stopped := f.start >= 0, s.stopped
		s.mu.Unlock()
		if stopped {
			return false
		}
		if started {
			return true
		}
		select {
		case <-s.wake:
		case <-s.done:
			return false
		case <-s.c.ctx.Done():
			return false
		}
	}
}

func (s *outStream) sendFile(f *outFile) error {
	s.mu.Lock()
	offset := f.sent
	s.mu.Unlock()
	if offset >= f.size {
		return nil
	}
	file, err := os.Open(f.path)
	if err != nil {
		return err
	}
	defer file.Close()
	for offset < f.size {
		select {
		case s.c.window <- struct{}{}:
		case <-s.done:
			return errStreamStopped
		case <-s.c.ctx.Done():
			return errStreamStopped
		}
		data := make([]byte, chunkLen(f.size, offset))
		if _, err := file.ReadAt(data, offset); err != nil {
			<-s.c.window
			return err
		}
		s.mu.Lock()
		if s.stopped {
			s.mu.Unlock()
			<-s.c.window
			return errStreamStopped
		}
		if !s.c.send(Frame{Type: FrameChunk, Chunk: &Chunk{TransferID: f.transferID, Attempt: s.attempt, Offset: offset, Data: data}}) {
			s.mu.Unlock()
			<-s.c.window
			return errStreamStopped
		}
		s.held++
		offset += int64(len(data))
		f.sent = offset
		f.ends = append(f.ends, offset)
		s.mu.Unlock()
	}
	return nil
}

// status reports the stream's files.
func (s *outStream) status() []TransferStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]TransferStatus, 0, len(s.files))
	for _, f := range s.files {
		out = append(out, TransferStatus{
			TransferID: f.transferID, MessageID: s.msg.MessageID, Peer: s.msg.To, Filename: f.filename,
			Direction: "send", Size: f.size, Bytes: max(f.acked, 0), Connected: !s.stopped,
		})
	}
	return out
}
