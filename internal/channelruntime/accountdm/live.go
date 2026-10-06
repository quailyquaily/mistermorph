package accountdm

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

// liveSender sends for code outside the runtime (contacts_send, cron results, heartbeats), through
// the runtime's bus so the messages are ordered with its replies.
type liveSender struct {
	channel   busruntime.Channel
	transport Transport
	bus       *busruntime.Inproc
	receipts  *deliveryReceipts
	peers     *peerBook
	seq       uint64
	seqMu     sync.Mutex
}

func (s *liveSender) SendText(ctx context.Context, peerID, text string) error {
	account := s.transport.AccountID()
	if account == "" {
		return fmt.Errorf("%s has not connected yet", s.channel)
	}
	if strings.TrimSpace(peerID) == "" {
		return fmt.Errorf("%s recipient is required", s.channel)
	}
	s.seqMu.Lock()
	s.seq++
	correlation := fmt.Sprintf("%s:live:%d:%d", s.channel, time.Now().UnixNano(), s.seq)
	s.seqMu.Unlock()
	return publishAndWait(ctx, s.bus, s.receipts, s.channel, account, peerID, text, "", correlation)
}

// SendFile sends a file the way the runtime's send-file tool does: straight through the transport,
// which handles images, videos and captions.
func (s *liveSender) SendFile(ctx context.Context, peerID, path, filename, caption string) error {
	account := s.transport.AccountID()
	if account == "" {
		return fmt.Errorf("%s has not connected yet", s.channel)
	}
	if strings.TrimSpace(peerID) == "" {
		return fmt.Errorf("%s recipient is required", s.channel)
	}
	if limit := s.transport.MaxFileBytes(); limit > 0 {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if info.Size() > limit {
			return fmt.Errorf("file too large for %s (>%d bytes): %s", s.channel, limit, path)
		}
	}
	return s.transport.SendFile(ctx, account, peerID, outboundFile(path, filename, caption))
}

// NotifyTargets are the users who wrote to this account. Both platforms let only one person use
// the account (the WeChat user who scanned the QR code, the WhatsApp agent's creator), so that is
// its owner.
func (s *liveSender) NotifyTargets() []string {
	return s.peers.list(s.transport.AccountID())
}

// peerBook remembers, per account, the users who wrote, in file_state_dir, so notifications reach
// them after a restart.
type peerBook struct {
	mu    sync.Mutex
	path  string
	state map[string][]string
}

func newPeerBook(stateDir string, channel busruntime.Channel) *peerBook {
	book := &peerBook{state: map[string][]string{}}
	if strings.TrimSpace(stateDir) == "" {
		return book
	}
	book.path = filepath.Join(stateDir, "accountdm", string(channel)+"_peers.json")
	_, _ = fsstore.ReadJSON(book.path, &book.state)
	if book.state == nil {
		book.state = map[string][]string{}
	}
	return book
}

func (b *peerBook) add(account, peerID string) {
	if account == "" || peerID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, known := range b.state[account] {
		if known == peerID {
			return
		}
	}
	b.state[account] = append(b.state[account], peerID)
	sort.Strings(b.state[account])
	if b.path != "" {
		_ = fsstore.WriteJSONAtomic(b.path, b.state, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
	}
}

func (b *peerBook) list(account string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.state[account]...)
}
