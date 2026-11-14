package agentlink

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

type incomingHopKey struct{}

// WithIncomingHop marks ctx as running a task an Agent Link message with hop started.
func WithIncomingHop(ctx context.Context, hop int) context.Context {
	return context.WithValue(ctx, incomingHopKey{}, hop)
}

// IncomingHop is the hop of the Agent Link message that started the task in ctx, or 0 when no
// message started it.
func IncomingHop(ctx context.Context) int {
	if ctx == nil {
		return 0
	}
	hop, _ := ctx.Value(incomingHopKey{}).(int)
	return hop
}

// OutgoingHop is the hop of a message the task in ctx sends.
func OutgoingHop(ctx context.Context) int {
	return IncomingHop(ctx) + 1
}

type replyFilesKey struct{}

// ReplyFiles collects the files a task answering an Agent Link message attaches to its answer: the
// runtime sends them with the answer as the reply. Each file is copied when it is attached, into a
// private folder of the collector's own, so what the answer carries is the file as it was then,
// whatever happens to it afterwards; Close removes the copies once the answer is queued (the queue
// keeps copies of its own) or the task ends without one.
type ReplyFiles struct {
	peer string
	// parent holds the collector's private folder, made on the first attach.
	parent string

	mu     sync.Mutex
	dir    string
	next   int
	closed bool
	files  []Attachment
}

// NewReplyFiles collects files for the answer to the agent with instance ID peer, copying them
// under dir (see Node.ReplyFilesDir).
func NewReplyFiles(peer, dir string) *ReplyFiles {
	return &ReplyFiles{peer: strings.TrimSpace(peer), parent: strings.TrimSpace(dir)}
}

// ReplyFilesDir is where the answers' files wait until they are queued, under the node's state
// directory. What a process that ended left there is removed when the node opens.
func (n *Node) ReplyFilesDir() string { return filepath.Join(n.dir, "reply-files") }

// WithReplyFiles marks ctx as running a task whose answer goes back to an agent with files.
func WithReplyFiles(ctx context.Context, files *ReplyFiles) context.Context {
	return context.WithValue(ctx, replyFilesKey{}, files)
}

// ReplyFilesFromContext returns the collector of the task in ctx, if its answer goes back to an
// agent.
func ReplyFilesFromContext(ctx context.Context) (*ReplyFiles, bool) {
	if ctx == nil {
		return nil, false
	}
	files, ok := ctx.Value(replyFilesKey{}).(*ReplyFiles)
	return files, ok && files != nil
}

// Peer is the instance ID of the agent the answer goes to.
func (r *ReplyFiles) Peer() string { return r.peer }

// AddFile attaches the regular file at path to the answer as filename, within the limits of one
// message, and returns it. The file must still have size bytes with SHA-256 digest, as the caller
// checked it; its bytes are copied now, privately, and the answer carries the copy. maxBytes is the
// most file bytes the answer carries in all on its route: MaxAttachmentBytes when the route does
// not stream files, MaxStreamMessageBytes when it does (see Node.FileLimit).
func (r *ReplyFiles) AddFile(path, filename string, size int64, digest string, maxBytes int64) (Attachment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case r.closed:
		return Attachment{}, errors.New("the answer was already sent")
	case len(r.files) >= MaxAttachments:
		return Attachment{}, fmt.Errorf("the answer already has %d files, the most one message carries", MaxAttachments)
	case attachmentBytes(r.files)+size > maxBytes:
		return Attachment{}, fmt.Errorf("the answer's files would pass %d bytes, the most one message carries on this route", maxBytes)
	case r.parent == "":
		return Attachment{}, errors.New("no folder for the answer's files")
	}
	if r.dir == "" {
		if err := os.MkdirAll(r.parent, 0o700); err != nil {
			return Attachment{}, fmt.Errorf("copy file: %w", err)
		}
		dir, err := os.MkdirTemp(r.parent, "reply-")
		if err != nil {
			return Attachment{}, fmt.Errorf("copy file: %w", err)
		}
		r.dir = dir
	}
	a, err := copyAttachmentFile(path, filepath.Join(r.dir, strconv.Itoa(r.next)), filename, size, digest)
	r.next++
	if err != nil {
		return Attachment{}, err
	}
	r.files = append(r.files, a)
	return a, nil
}

// Close removes the copies of the attached files; nothing can be attached after it.
func (r *ReplyFiles) Close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if r.dir != "" {
		_ = os.RemoveAll(r.dir)
	}
}

// Attachments returns the files attached so far.
func (r *ReplyFiles) Attachments() []Attachment {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Attachment(nil), r.files...)
}
