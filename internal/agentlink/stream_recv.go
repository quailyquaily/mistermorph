package agentlink

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"
)

// The receiving side of streamed files. A streamed delivery is checked as a whole before any byte
// is taken: first the message, its attempt and the sender's authorization, and only then room in
// the inbox, so a delivery that is refused never costs another one its partial files. Then each
// file gets a
// private partial file, chunks are written to it as they come and hashed on the way, and the last
// chunk of a file checks its size and SHA-256. Once every file is complete, they are synced and
// published, and the message goes to the waiting send or the handler, as an inline one does.
//
// An unfinished delivery outlives its connection: it waits, for up to partialFileMaxAge without
// progress, for the sender to deliver the message again through any Console, and then continues
// from the bytes it holds. It lives in memory: after a restart the sender starts again from 0, and
// the abandoned partial files go with the inbox cleanup.

// inStream is one streamed delivery being received.
type inStream struct {
	key      string
	msg      Message
	inbox    *fileInbox
	answer   bool
	reserved int64

	mu sync.Mutex
	// conn is the connection the delivery arrives on; nil while it waits for a resume. attempt is
	// the sender's attempt that conn carries: chunks and aborts of any other are stale.
	conn    *nodeConn
	attempt string
	// ready is set once the partial files exist and the first acknowledgements went out.
	ready bool
	// finishing is set once every byte arrived; closed once the delivery is dropped.
	finishing, closed bool
	files             []*inFile
	lastActive        time.Time
}

type inFile struct {
	transferID string
	filename   string
	// rel is the partial file under file_cache_dir; path the same, absolute.
	rel, path string
	f         *os.File
	hash      hash.Hash
	sha256    string
	size      int64
	written   int64
	loggedAt  int64
}

func streamKey(from, messageID string) string { return from + "\x00" + messageID }

func (s *inStream) file(transferID string) *inFile {
	for _, f := range s.files {
		if f.transferID == transferID {
			return f
		}
	}
	return nil
}

func (s *inStream) complete() bool {
	for _, f := range s.files {
		if f.written < f.size {
			return false
		}
	}
	return true
}

func (s *inStream) status() []TransferStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]TransferStatus, 0, len(s.files))
	for _, a := range s.msg.Attachments {
		st := TransferStatus{
			TransferID: a.TransferID, MessageID: s.msg.MessageID, Peer: s.msg.From, Filename: a.Filename,
			Direction: "receive", Size: a.Size, Connected: s.conn != nil,
		}
		if f := s.file(a.TransferID); f != nil {
			st.Bytes = f.written
		}
		out = append(out, st)
	}
	return out
}

// handleStreamDeliver starts or resumes a streamed delivery of attempt.
func (n *Node) handleStreamDeliver(c *nodeConn, attempt string, msg Message, reply func(status, reason string)) {
	if !validAttemptID(attempt) {
		reply(StatusRejected, ReasonInvalid)
		return
	}
	key := streamKey(msg.From, msg.MessageID)
	n.mu.Lock()
	adm := n.admitStreamLocked(key, msg)
	n.mu.Unlock()
	switch {
	case adm.status != "":
		reply(adm.status, adm.reason)
		return
	case adm.resume != nil:
		n.resumeStream(c, adm.resume, attempt, msg, reply)
		return
	}
	// The sender's authorization comes before anything that takes room: a sender that may not
	// send files must not cost an authorized delivery waiting for a resume its partial files.
	if !adm.answer {
		if err := n.authorizeFiles(adm.inbox, msg.From); err != nil {
			n.logger.Warn("agentlink_transfer_rejected", "message_id", msg.MessageID, "from", msg.From, "reason", ReasonUnauthorized, "error", err.Error())
			reply(StatusRejected, ReasonUnauthorized)
			return
		}
	}
	total := attachmentBytes(msg.Attachments)
	n.mu.Lock()
	// Checked again: another Console may have delivered the message, or the inbox changed, while
	// the authorizer ran.
	again := n.admitStreamLocked(key, msg)
	if again.status != "" || again.resume != nil || again.inbox != adm.inbox {
		n.mu.Unlock()
		if again.status != "" {
			reply(again.status, again.reason)
		} else {
			reply(StatusUnreachable, "")
		}
		return
	}
	evicted, ok := n.makeRoomLocked(total)
	if !ok {
		// Other deliveries hold the room; the sender retries later.
		n.mu.Unlock()
		reply(StatusUnreachable, "")
		return
	}
	inbox, answer := adm.inbox, adm.answer
	s := &inStream{key: key, msg: msg, inbox: inbox, answer: answer, reserved: total, conn: c, attempt: attempt, lastActive: n.opts.Now()}
	n.inStreams[key] = s
	for _, a := range msg.Attachments {
		n.inTransfers[a.TransferID] = s
	}
	n.inboundReserved += total
	n.mu.Unlock()
	n.dropInStreams(evicted)

	if err := n.openParts(s); err != nil {
		n.rejectStream(s, ReasonAttachmentStore, err)
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.ready = true
	conn, attempt := s.conn, s.attempt
	complete := s.complete()
	if complete {
		s.finishing = true
	}
	s.mu.Unlock()
	n.logger.Info("agentlink_transfer_started", "direction", "receive", "message_id", msg.MessageID, "from", msg.From,
		"files", len(msg.Attachments), "size", total)
	if conn != nil {
		for _, a := range msg.Attachments {
			conn.send(Frame{Type: FrameChunkAck, Attempt: attempt, MessageID: msg.MessageID, TransferID: a.TransferID, Offset: 0})
		}
	}
	if complete {
		// Empty files only.
		n.completeStream(s)
	}
}

// streamAdmission is what admitStreamLocked found about a streamed delivery: a refusal (status),
// an unfinished delivery to resume, or a new one for inbox (answer when a send waits for it).
type streamAdmission struct {
	status, reason string
	resume         *inStream
	inbox          *fileInbox
	answer         bool
}

// admitStreamLocked checks what does not depend on room in the inbox. It changes nothing.
func (n *Node) admitStreamLocked(key string, msg Message) streamAdmission {
	if _, seen := n.seen[msg.MessageID]; seen {
		// Saved before: nothing is taken again.
		return streamAdmission{status: StatusAccepted}
	}
	switch {
	case n.files == nil:
		return streamAdmission{status: StatusRejected, reason: ReasonFilesUnsupported}
	case n.noStream:
		// What a runtime from before streamed files answers.
		return streamAdmission{status: StatusRejected, reason: ReasonInvalid}
	case n.inflight[msg.MessageID]:
		return streamAdmission{status: StatusUnreachable}
	}
	if s := n.inStreams[key]; s != nil {
		return streamAdmission{resume: s}
	}
	for _, a := range msg.Attachments {
		if n.inTransfers[a.TransferID] != nil {
			// A transfer ID is one file of one message.
			return streamAdmission{status: StatusRejected, reason: ReasonInvalid}
		}
	}
	// An answer to a message this runtime sent is wanted; anything else needs authorizing.
	answer := n.replyWaitingLocked(msg)
	if slot := n.handler; !answer && (slot == nil || slot.handle == nil) {
		return streamAdmission{status: StatusRejected, reason: ReasonNoHandler}
	}
	return streamAdmission{inbox: n.files, answer: answer}
}

// resumeStream moves an unfinished delivery to the connection and attempt that delivered it again,
// and tells the sender what it holds.
func (n *Node) resumeStream(c *nodeConn, s *inStream, attempt string, msg Message, reply func(status, reason string)) {
	s.mu.Lock()
	switch {
	case s.closed || !s.ready || s.finishing:
		s.mu.Unlock()
		reply(StatusUnreachable, "")
		return
	case !sameTransfers(s.msg.Attachments, msg.Attachments):
		// The same message from the same sender with other files: refused, not resumed.
		s.mu.Unlock()
		reply(StatusRejected, ReasonInvalid)
		return
	}
	// From here on, chunks and aborts of the attempt before are stale.
	s.conn = c
	s.attempt = attempt
	s.lastActive = n.opts.Now()
	acks := make([]Frame, 0, len(s.files))
	for _, f := range s.files {
		acks = append(acks, Frame{Type: FrameChunkAck, Attempt: attempt, MessageID: msg.MessageID, TransferID: f.transferID, Offset: f.written})
	}
	s.mu.Unlock()
	for _, ack := range acks {
		n.logger.Info("agentlink_transfer_resumed", "direction", "receive", "message_id", msg.MessageID, "from", msg.From,
			"transfer_id", ack.TransferID, "offset", ack.Offset)
		c.send(ack)
	}
}

// makeRoomLocked checks there is room for a streamed delivery of total bytes, making it by dropping
// the oldest deliveries that wait for a resume. It returns the deliveries to drop; when there is no
// room even without them it drops none.
func (n *Node) makeRoomLocked(total int64) ([]*inStream, bool) {
	count, reserved := len(n.inStreams), n.inboundReserved
	dropping := make(map[*inStream]bool)
	var evicted []*inStream
	for count >= maxInboundStreams || reserved+total > maxInboundStreamBytes {
		var oldest *inStream
		var oldestAt time.Time
		for _, s := range n.inStreams {
			if dropping[s] {
				continue
			}
			s.mu.Lock()
			parked, at := s.conn == nil && s.ready && !s.finishing && !s.closed, s.lastActive
			s.mu.Unlock()
			if parked && (oldest == nil || at.Before(oldestAt)) {
				oldest, oldestAt = s, at
			}
		}
		if oldest == nil {
			return nil, false
		}
		dropping[oldest] = true
		evicted = append(evicted, oldest)
		count--
		reserved -= oldest.reserved
	}
	return evicted, true
}

// openParts creates the delivery's partial files.
func (n *Node) openParts(s *inStream) error {
	n.fileMu.Lock()
	defer n.fileMu.Unlock()
	root, err := os.OpenRoot(s.inbox.cacheDir)
	if err != nil {
		return err
	}
	defer root.Close()
	// Free the room the delivery reserved before taking any byte. (The cleanup removes empty
	// folders, so it goes first.)
	n.cleanInbox(filepath.Join(s.inbox.cacheDir, InboxDirName), map[string]bool{})
	dir := path.Join(InboxDirName, safeFileName(s.msg.From))
	for _, d := range []string{InboxDirName, dir} {
		if err := ensurePrivateDir(root, d); err != nil {
			return err
		}
	}
	files := make([]*inFile, 0, len(s.msg.Attachments))
	for _, a := range s.msg.Attachments {
		rel, f, err := createPart(root, dir)
		if err != nil {
			closeParts(files)
			return err
		}
		files = append(files, &inFile{
			transferID: a.TransferID, filename: a.Filename, rel: rel,
			path: filepath.Join(s.inbox.cacheDir, filepath.FromSlash(rel)),
			f:    f, hash: sha256.New(), sha256: a.SHA256, size: a.Size,
		})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		closeParts(files)
		return nil
	}
	s.files = files
	return nil
}

// closeParts closes and removes partial files.
func closeParts(files []*inFile) {
	for _, f := range files {
		if f.f != nil {
			_ = f.f.Close()
			f.f = nil
		}
		_ = os.Remove(f.path)
	}
}

// handleChunk writes a chunk to its partial file and acknowledges it. A chunk out of order, of the
// wrong length or past the file's size, or a file whose bytes do not match its SHA-256, rejects the
// delivery and removes its partial files.
func (n *Node) handleChunk(c *nodeConn, frame Frame) {
	chunk := frame.Chunk
	if chunk == nil {
		n.logger.Warn("agentlink_bad_binary_frame", "reason", frame.Reason)
		return
	}
	n.mu.Lock()
	s := n.inTransfers[chunk.TransferID]
	n.mu.Unlock()
	if s == nil {
		// A chunk of a delivery that ended; it is late, not harmful.
		n.logger.Debug("agentlink_stale_chunk", "transfer_id", chunk.TransferID, "offset", chunk.Offset)
		return
	}
	s.mu.Lock()
	if s.closed || s.conn != c || chunk.Attempt != s.attempt {
		// Sent in an attempt before the delivery moved to another connection or attempt.
		s.mu.Unlock()
		return
	}
	f := s.file(chunk.TransferID)
	var problem error
	switch {
	case !s.ready || s.finishing || f == nil:
		problem = fmt.Errorf("chunk before the transfer was ready")
	case chunk.Offset != f.written:
		problem = fmt.Errorf("chunk out of order (offset %d, expected %d)", chunk.Offset, f.written)
	case f.written >= f.size:
		problem = fmt.Errorf("chunk past the declared size %d", f.size)
	case int64(len(chunk.Data)) != chunkLen(f.size, f.written):
		problem = fmt.Errorf("chunk of %d bytes at offset %d, expected %d", len(chunk.Data), chunk.Offset, chunkLen(f.size, f.written))
	}
	if problem != nil {
		s.mu.Unlock()
		n.rejectStream(s, ReasonInvalid, problem)
		return
	}
	if err := writeAttachmentData(f.f, chunk.Data); err != nil {
		s.mu.Unlock()
		n.rejectStream(s, ReasonAttachmentStore, err)
		return
	}
	f.hash.Write(chunk.Data)
	f.written += int64(len(chunk.Data))
	s.lastActive = n.opts.Now()
	if f.written == f.size && hex.EncodeToString(f.hash.Sum(nil)) != f.sha256 {
		s.mu.Unlock()
		n.rejectStream(s, ReasonInvalid, fmt.Errorf("file %q does not match its sha256", f.filename))
		return
	}
	if f.written == f.size || f.written-f.loggedAt >= streamProgressStep {
		f.loggedAt = f.written
		n.logger.Info("agentlink_transfer_progress", "direction", "receive", "message_id", s.msg.MessageID, "from", s.msg.From,
			"transfer_id", f.transferID, "bytes", f.written, "size", f.size)
	}
	complete := s.complete()
	if complete {
		s.finishing = true
	}
	written, attempt := f.written, s.attempt
	s.mu.Unlock()
	c.send(Frame{Type: FrameChunkAck, Attempt: attempt, MessageID: s.msg.MessageID, TransferID: chunk.TransferID, Offset: written})
	if complete {
		go n.completeStream(s)
	}
}

// handleTransferAbort ends or parks the delivery a relay dropped.
func (n *Node) handleTransferAbort(c *nodeConn, frame Frame) {
	n.mu.Lock()
	var target *inStream
	for _, s := range n.inStreams {
		if s.msg.MessageID == frame.MessageID {
			target = s
		}
	}
	n.mu.Unlock()
	if target == nil {
		return
	}
	target.mu.Lock()
	if target.conn != c || target.finishing || frame.Attempt != target.attempt {
		// Not the delivery's current attempt: the relay dropped one that has been replaced.
		target.mu.Unlock()
		return
	}
	if frame.Status != StatusRejected {
		// The sender went away; the delivery waits for it to come back.
		target.conn = nil
		target.mu.Unlock()
		return
	}
	target.mu.Unlock()
	n.rejectStream(target, "", fmt.Errorf("relay dropped the transfer: %s", frame.Reason))
}

// parkInStreams makes the deliveries arriving on a closed connection wait for a resume.
func (n *Node) parkInStreams(c *nodeConn) {
	n.mu.Lock()
	streams := make([]*inStream, 0, len(n.inStreams))
	for _, s := range n.inStreams {
		streams = append(streams, s)
	}
	n.mu.Unlock()
	for _, s := range streams {
		s.mu.Lock()
		if s.conn == c {
			s.conn = nil
		}
		s.mu.Unlock()
	}
}

// unregisterLocked forgets a delivery and the room it reserved, reporting whether it was known.
func (n *Node) unregisterLocked(s *inStream) bool {
	if n.inStreams[s.key] != s {
		return false
	}
	delete(n.inStreams, s.key)
	for _, a := range s.msg.Attachments {
		if n.inTransfers[a.TransferID] == s {
			delete(n.inTransfers, a.TransferID)
		}
	}
	n.inboundReserved -= s.reserved
	return true
}

// rejectStream drops a delivery and its partial files and, when reason is set, tells the sender.
func (n *Node) rejectStream(s *inStream, reason string, err error) {
	n.mu.Lock()
	known := n.unregisterLocked(s)
	n.mu.Unlock()
	s.mu.Lock()
	if !known || s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	conn, attempt := s.conn, s.attempt
	closeParts(s.files)
	s.mu.Unlock()
	n.logger.Warn("agentlink_transfer_rejected", "message_id", s.msg.MessageID, "from", s.msg.From, "reason", reason, "error", err.Error())
	if reason != "" && conn != nil {
		conn.send(Frame{Type: FrameDeliverResult, Attempt: attempt, MessageID: s.msg.MessageID, Status: StatusRejected, Reason: reason})
	}
}

// dropInStreams removes deliveries without telling anyone, for deliveries no connection carries.
func (n *Node) dropInStreams(streams []*inStream) {
	for _, s := range streams {
		n.mu.Lock()
		known := n.unregisterLocked(s)
		n.mu.Unlock()
		s.mu.Lock()
		if known && !s.closed {
			s.closed = true
			closeParts(s.files)
			n.logger.Info("agentlink_transfer_abandoned", "message_id", s.msg.MessageID, "from", s.msg.From)
		}
		s.mu.Unlock()
	}
}

// sweepInStreams drops deliveries without progress for partialFileMaxAge.
func (n *Node) sweepInStreams() {
	cutoff := n.opts.Now().Add(-partialFileMaxAge)
	n.mu.Lock()
	var stale []*inStream
	for _, s := range n.inStreams {
		s.mu.Lock()
		if !s.finishing && s.lastActive.Before(cutoff) {
			stale = append(stale, s)
		}
		s.mu.Unlock()
	}
	n.mu.Unlock()
	n.dropInStreams(stale)
}

// closeInStreams closes the partial files of the unfinished deliveries when the node closes; the
// inbox cleanup removes them later.
func (n *Node) closeInStreams() {
	n.mu.Lock()
	streams := make([]*inStream, 0, len(n.inStreams))
	for _, s := range n.inStreams {
		streams = append(streams, s)
		n.unregisterLocked(s)
	}
	n.mu.Unlock()
	for _, s := range streams {
		s.mu.Lock()
		if !s.finishing {
			s.closed = true
			for _, f := range s.files {
				if f.f != nil {
					_ = f.f.Close()
					f.f = nil
				}
			}
		}
		s.mu.Unlock()
	}
}

// protectInStreams adds the partial files of unfinished deliveries to protected, and returns the
// bytes they still expect.
func (n *Node) protectInStreams(protected map[string]bool) int64 {
	n.mu.Lock()
	streams := make([]*inStream, 0, len(n.inStreams))
	for _, s := range n.inStreams {
		streams = append(streams, s)
	}
	n.mu.Unlock()
	var pending int64
	for _, s := range streams {
		s.mu.Lock()
		if len(s.files) == 0 {
			pending += s.reserved
		}
		for _, f := range s.files {
			protected[f.path] = true
			pending += f.size - f.written
		}
		s.mu.Unlock()
	}
	return pending
}

// completeStream publishes a delivery whose files all arrived, and hands the message over.
func (n *Node) completeStream(s *inStream) {
	n.mu.Lock()
	if n.inStreams[s.key] != s {
		n.mu.Unlock()
		return
	}
	n.inflight[s.msg.MessageID] = true
	n.mu.Unlock()
	reply := func(status, reason string) {
		s.mu.Lock()
		conn, attempt := s.conn, s.attempt
		s.mu.Unlock()
		if conn != nil {
			conn.send(Frame{Type: FrameDeliverResult, Attempt: attempt, MessageID: s.msg.MessageID, Status: status, Reason: reason})
		}
	}
	saved, err := n.publishParts(s)
	n.mu.Lock()
	n.unregisterLocked(s)
	n.mu.Unlock()
	s.mu.Lock()
	s.closed = true
	closeParts(s.files)
	s.mu.Unlock()
	msg := s.msg
	if err != nil {
		n.rejectDelivery(msg, ReasonAttachmentStore, err, reply)
		return
	}
	msg.Attachments = saved
	n.logger.Info("agentlink_transfer_finished", "direction", "receive", "message_id", msg.MessageID, "from", msg.From,
		"files", len(saved), "size", attachmentBytes(saved))
	n.acceptFiles(msg, s.inbox, !s.answer, reply)
}

// publishParts syncs the delivery's partial files and publishes them under their final names. On
// error nothing it published stays.
func (n *Node) publishParts(s *inStream) ([]Attachment, error) {
	s.mu.Lock()
	files := s.files
	s.mu.Unlock()
	for _, f := range files {
		if f.f == nil {
			return nil, errors.New("partial file closed")
		}
		err := f.f.Sync()
		if closeErr := f.f.Close(); err == nil {
			err = closeErr
		}
		f.f = nil
		if err != nil {
			return nil, err
		}
	}
	n.fileMu.Lock()
	defer n.fileMu.Unlock()
	root, err := os.OpenRoot(s.inbox.cacheDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir := path.Join(InboxDirName, safeFileName(s.msg.From))
	saved := make([]Attachment, 0, len(files))
	for i, f := range files {
		info, err := root.Lstat(f.rel)
		if err != nil || !info.Mode().IsRegular() || info.Size() != f.size {
			removeAttachments(saved)
			return nil, fmt.Errorf("partial file of %q changed", f.filename)
		}
		final, err := linkPart(root, dir, f.rel, f.filename)
		if err != nil {
			removeAttachments(saved)
			return nil, err
		}
		a := s.msg.Attachments[i]
		a.Path = filepath.Join(s.inbox.cacheDir, filepath.FromSlash(final))
		a.Ref = "file_cache_dir/" + final
		saved = append(saved, a)
	}
	protected := make(map[string]bool, len(saved))
	for _, a := range saved {
		protected[a.Path] = true
	}
	n.cleanInbox(filepath.Join(s.inbox.cacheDir, InboxDirName), protected)
	return saved, nil
}
