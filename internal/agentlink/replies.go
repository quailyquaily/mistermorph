package agentlink

import (
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const maxAskEntries = 1000

// Origin is the conversation a message was sent from, so that its reply can find its way back.
type Origin struct {
	Runtime         string `json:"runtime,omitempty"`
	ConversationKey string `json:"conversation_key,omitempty"`
	TopicID         string `json:"topic_id,omitempty"`
}

type askRecord struct {
	To        string    `json:"to"`
	Origin    Origin    `json:"origin"`
	CreatedAt time.Time `json:"created_at"`
}

type replyWaiter struct {
	to string
	ch chan Message
}

// ExpectReply is called before sending messageID to the agent to: while the returned channel is
// open, that agent's reply to the message goes to it instead of the handler. stop closes it. A reply
// that comes later goes to the handler, and AskOrigin tells it which conversation asked.
func (n *Node) ExpectReply(messageID, to string, origin Origin) (replies <-chan Message, stop func()) {
	messageID = strings.TrimSpace(messageID)
	to = strings.TrimSpace(to)
	w := &replyWaiter{to: to, ch: make(chan Message, 1)}
	n.mu.Lock()
	n.replies[messageID] = w
	n.asks[messageID] = askRecord{To: to, Origin: origin, CreatedAt: n.opts.Now().UTC()}
	n.saveAsksLocked()
	n.mu.Unlock()
	return w.ch, func() {
		n.mu.Lock()
		if n.replies[messageID] == w {
			delete(n.replies, messageID)
		}
		n.mu.Unlock()
	}
}

// ForgetAsk drops what ExpectReply kept for messageID, for a message that was not sent after all.
func (n *Node) ForgetAsk(messageID string) {
	messageID = strings.TrimSpace(messageID)
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, ok := n.asks[messageID]; ok {
		delete(n.asks, messageID)
		n.saveAsksLocked()
	}
}

// AskOrigin returns the conversation that sent the message msg replies to, when msg comes from the
// agent the message went to. The record is dropped: a reply finds its way back once.
func (n *Node) AskOrigin(msg Message) (Origin, bool) {
	replyTo := strings.TrimSpace(msg.Envelope.ReplyTo)
	if replyTo == "" {
		return Origin{}, false
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	record, ok := n.asks[replyTo]
	if !ok || record.To != msg.From {
		return Origin{}, false
	}
	delete(n.asks, replyTo)
	n.saveAsksLocked()
	return record.Origin, true
}

// SessionFor returns the session ID for the dialogue that conversationKey holds with the agent to,
// the same for every message of it while the node runs, so the other agent keeps it in one
// conversation.
func (n *Node) SessionFor(conversationKey, to string) string {
	key := strings.TrimSpace(conversationKey) + "\x00" + strings.TrimSpace(to)
	n.mu.Lock()
	defer n.mu.Unlock()
	if id := n.sessions[key]; id != "" {
		return id
	}
	id, err := uuid.NewV7()
	if err != nil {
		return ""
	}
	n.sessions[key] = id.String()
	return id.String()
}

// takeReplyLocked hands msg to whoever waits for it, reporting whether someone did.
func (n *Node) takeReplyLocked(msg Message) bool {
	w := n.replies[strings.TrimSpace(msg.Envelope.ReplyTo)]
	if w == nil || w.to != msg.From {
		return false
	}
	select {
	case w.ch <- msg:
	default:
		// The waiter already has a reply; a second one goes to the handler.
		return false
	}
	delete(n.asks, msg.Envelope.ReplyTo)
	n.saveAsksLocked()
	return true
}

type asksFile struct {
	Asks map[string]askRecord `json:"asks"`
}

func (n *Node) asksPath() string { return filepath.Join(n.dir, "asks.json") }

func (n *Node) loadAsks() {
	var file asksFile
	if _, err := fsstore.ReadJSON(n.asksPath(), &file); err != nil {
		n.logger.Warn("agentlink_asks_load_error", "error", err.Error())
		return
	}
	for id, record := range file.Asks {
		n.asks[id] = record
	}
}

func (n *Node) saveAsksLocked() {
	cutoff := n.opts.Now().Add(-seenRetention)
	for id, record := range n.asks {
		if record.CreatedAt.Before(cutoff) {
			delete(n.asks, id)
		}
	}
	if len(n.asks) > maxAskEntries {
		ids := make([]string, 0, len(n.asks))
		for id := range n.asks {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return n.asks[ids[i]].CreatedAt.Before(n.asks[ids[j]].CreatedAt) })
		for _, id := range ids[:len(ids)-maxAskEntries] {
			delete(n.asks, id)
		}
	}
	if err := fsstore.WriteJSONAtomic(n.asksPath(), asksFile{Asks: n.asks}, fsstore.FileOptions{}); err != nil {
		n.logger.Warn("agentlink_asks_save_error", "error", err.Error())
	}
}
