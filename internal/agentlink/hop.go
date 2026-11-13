package agentlink

import (
	"context"
	"fmt"
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
// runtime sends them with the answer as the reply.
type ReplyFiles struct {
	peer string

	mu    sync.Mutex
	files []Attachment
}

// NewReplyFiles collects files for the answer to the agent with instance ID peer.
func NewReplyFiles(peer string) *ReplyFiles {
	return &ReplyFiles{peer: strings.TrimSpace(peer)}
}

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

// Add attaches a file to the answer, within the limits of one message. maxBytes is the most file
// bytes the answer carries in all on its route: MaxAttachmentBytes when the route does not stream
// files, MaxStreamMessageBytes when it does (see Node.FileLimit).
func (r *ReplyFiles) Add(a Attachment, maxBytes int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.files) >= MaxAttachments {
		return fmt.Errorf("the answer already has %d files, the most one message carries", MaxAttachments)
	}
	if attachmentBytes(r.files)+a.Size > maxBytes {
		return fmt.Errorf("the answer's files would pass %d bytes, the most one message carries on this route", maxBytes)
	}
	r.files = append(r.files, a)
	return nil
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
