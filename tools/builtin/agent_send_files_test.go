package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentlink"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
)

// filePeer is an agent on another machine: its own state and file_cache_dir. It answers each
// message with text, and with a file when answerFile is set.
type filePeer struct {
	node  *agentlink.Node
	cache string

	mu         sync.Mutex
	received   []agentlink.Message
	answerFile []byte
}

func (p *filePeer) handle(_ context.Context, msg agentlink.Message) error {
	p.mu.Lock()
	p.received = append(p.received, msg)
	answerFile := p.answerFile
	p.mu.Unlock()
	if msg.Envelope.ReplyTo != "" {
		return nil
	}
	go func() {
		reply := busruntime.MessageEnvelope{Text: "got it", SessionID: msg.Envelope.SessionID, ReplyTo: msg.MessageID}
		var files []agentlink.Attachment
		if answerFile != nil {
			a, _ := agentlink.NewAttachment("result.bin", answerFile)
			files = append(files, a)
		}
		_, _ = p.node.SendWithAttachments(context.Background(), msg.From, reply, files, msg.Hop+1, 0)
	}()
	return nil
}

func (p *filePeer) messages() []agentlink.Message {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]agentlink.Message(nil), p.received...)
}

type fileSendFixture struct {
	ctx         context.Context
	stateDir    string
	cache       string
	workspace   string
	outside     string
	contactsDir string
	node        *agentlink.Node
	opts        ContactsSendToolOptions
}

func newFileSendFixture(t *testing.T) *fileSendFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	base := t.TempDir()
	f := &fileSendFixture{
		ctx:         ctx,
		stateDir:    filepath.Join(base, "state"),
		cache:       filepath.Join(base, "cache"),
		workspace:   filepath.Join(base, "workspace"),
		outside:     filepath.Join(base, "outside"),
		contactsDir: filepath.Join(base, "state", "contacts"),
	}
	for _, dir := range []string{f.stateDir, f.cache, f.workspace, f.outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	node, err := agentlink.Shared(agentlink.Options{StateDir: f.stateDir})
	if err != nil {
		t.Fatal(err)
	}
	restore, err := node.EnableFiles(f.cache, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restore)
	f.node = node
	f.opts = ContactsSendToolOptions{
		Enabled: true, ContactsDir: f.contactsDir, StateDir: f.stateDir, AgentSendCooldown: time.Hour,
		AgentLinkReplyTimeout: 5 * time.Second, PathRoots: pathroots.New(f.workspace, f.cache, f.stateDir),
	}
	return f
}

// peer links a new agent through relay; withFiles makes it take files.
func (f *fileSendFixture) peer(t *testing.T, relay *agentlink.Relay, name string, withFiles bool) *filePeer {
	t.Helper()
	node, err := agentlink.NewNode(agentlink.Options{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(node.Close)
	p := &filePeer{node: node}
	if withFiles {
		p.cache = filepath.Join(t.TempDir(), "peer-cache")
		restore, err := node.EnableFiles(p.cache, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(restore)
	}
	node.SetHandler(p.handle)
	a, b := agentlink.Pipe()
	go func() { _ = node.Serve(f.ctx, a) }()
	go func() { _ = relay.Serve(f.ctx, b, name) }()
	deadline := time.Now().Add(5 * time.Second)
	for !f.node.Reachable(node.InstanceID()) || withFiles && !f.node.SupportsFiles(node.InstanceID()) {
		if time.Now().After(deadline) {
			t.Fatal("peer never became reachable")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := contacts.NewStore(f.contactsDir).PutContact(f.ctx, contacts.Contact{
		ContactID: agentlink.ContactID(node.InstanceID()), Kind: contacts.KindAgent, Channel: contacts.ChannelAgentLink, ContactNickname: name,
	}); err != nil {
		t.Fatal(err)
	}
	return p
}

func (f *fileSendFixture) relay(t *testing.T) *agentlink.Relay {
	t.Helper()
	relay := agentlink.NewRelay(nil)
	a, b := agentlink.Pipe()
	go func() { _ = f.node.Serve(f.ctx, a) }()
	go func() { _ = relay.Serve(f.ctx, b, "self") }()
	return relay
}

func (f *fileSendFixture) write(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func execAgentSend(t *testing.T, ctx context.Context, opts ContactsSendToolOptions, params map[string]any) (map[string]any, error) {
	t.Helper()
	out, err := NewAgentSendTool(opts).Execute(ctx, params)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("result %s: %v", out, err)
	}
	return result, nil
}

func TestAgentSendFilesOverAgentLink(t *testing.T) {
	f := newFileSendFixture(t)
	relay := f.relay(t)
	peer := f.peer(t, relay, "Peer", true)
	peerContact := agentlink.ContactID(peer.node.InstanceID())
	ctx := topiccontext.WithScope(f.ctx, topiccontext.Scope{Runtime: "console", ConversationKey: "console:t1", TopicID: "t1"})
	binary := make([]byte, 64<<10)
	for i := range binary {
		binary[i] = byte(i * 7)
	}
	f.write(t, f.cache, "data.bin", binary)
	f.write(t, f.workspace, "empty.txt", nil)

	t.Run("text with a binary file", func(t *testing.T) {
		var mu sync.Mutex
		var sent []string
		eventsCtx := agent.WithEventSinkContext(ctx, agent.EventSinkFunc(func(_ context.Context, e agent.Event) {
			if e.Stream == AgentLinkStreamSent {
				mu.Lock()
				sent = append(sent, e.Text)
				mu.Unlock()
			}
		}))
		result, err := execAgentSend(t, eventsCtx, f.opts, map[string]any{"contact_id": peerContact, "message_text": "the data", "path": "file_cache_dir/data.bin"})
		if err != nil {
			t.Fatal(err)
		}
		if outcome := result["outcome"].(map[string]any); outcome["accepted"] != true {
			t.Fatalf("outcome = %v", outcome)
		}
		if r := result["reply"].(map[string]any); r["status"] != "replied" || r["text"] != "got it" {
			t.Fatalf("reply = %v", r)
		}
		msg := peer.messages()[len(peer.messages())-1]
		if msg.Envelope.Text != "the data" || len(msg.Attachments) != 1 {
			t.Fatalf("peer got %+v", msg)
		}
		got := msg.Attachments[0]
		saved, err := os.ReadFile(got.Path)
		if err != nil || !bytes.Equal(saved, binary) || got.Filename != "data.bin" || got.Size != int64(len(binary)) {
			t.Fatalf("peer saved %+v (%d bytes): %v", got, len(saved), err)
		}
		resolvedPeerCache, _ := filepath.EvalSymlinks(peer.cache)
		if !strings.HasPrefix(got.Path, resolvedPeerCache+string(filepath.Separator)) {
			t.Fatalf("saved at %s, outside the peer's own file_cache_dir", got.Path)
		}
		mu.Lock()
		defer mu.Unlock()
		if len(sent) != 1 || !strings.Contains(sent[0], "the data") || !strings.Contains(sent[0], "data.bin") {
			t.Fatalf("sent events = %q", sent)
		}
	})

	t.Run("an empty file without text, under another display name", func(t *testing.T) {
		result, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": peerContact, "path": "workspace_dir/empty.txt", "filename": "Résumé final.txt"})
		if err != nil {
			t.Fatal(err)
		}
		if outcome := result["outcome"].(map[string]any); outcome["accepted"] != true {
			t.Fatalf("outcome = %v", outcome)
		}
		msg := peer.messages()[len(peer.messages())-1]
		if msg.Envelope.Text != "" || len(msg.Attachments) != 1 {
			t.Fatalf("peer got %+v", msg)
		}
		got := msg.Attachments[0]
		info, err := os.Stat(got.Path)
		if err != nil || info.Size() != 0 || got.Size != 0 || got.Filename != "Résumé final.txt" || !strings.HasPrefix(got.MediaType, "text/plain") {
			t.Fatalf("peer saved %+v: %v", got, err)
		}
	})

	t.Run("a file in the reply", func(t *testing.T) {
		answer := []byte("\x00\x01binary answer\xff")
		peer.mu.Lock()
		peer.answerFile = answer
		peer.mu.Unlock()
		defer func() {
			peer.mu.Lock()
			peer.answerFile = nil
			peer.mu.Unlock()
		}()
		result, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": peerContact, "message_text": "send me the result"})
		if err != nil {
			t.Fatal(err)
		}
		r := result["reply"].(map[string]any)
		attachments, _ := r["attachments"].([]any)
		if r["status"] != "replied" || len(attachments) != 1 {
			t.Fatalf("reply = %v", r)
		}
		meta := attachments[0].(map[string]any)
		ref, _ := meta["path"].(string)
		if meta["filename"] != "result.bin" || meta["size"] != float64(len(answer)) || !strings.HasPrefix(ref, "file_cache_dir/agentlink/"+peer.node.InstanceID()+"/") {
			t.Fatalf("attachment = %v", meta)
		}
		saved, err := os.ReadFile(filepath.Join(f.cache, strings.TrimPrefix(ref, "file_cache_dir/")))
		if err != nil || !bytes.Equal(saved, answer) {
			t.Fatalf("saved %q: %v", saved, err)
		}
	})

	t.Run("refused before anything is sent", func(t *testing.T) {
		big := f.write(t, f.cache, "big.bin", make([]byte, agentlink.MaxAttachmentBytes+1))
		f.write(t, f.outside, "secret.txt", []byte("secret"))
		if err := os.Symlink(filepath.Join(f.outside, "secret.txt"), filepath.Join(f.cache, "escape.txt")); err != nil {
			t.Fatal(err)
		}
		f.write(t, f.stateDir, "state.txt", []byte("state"))
		if err := os.MkdirAll(filepath.Join(f.cache, "folder"), 0o755); err != nil {
			t.Fatal(err)
		}
		unreadable := f.write(t, f.cache, "unreadable.txt", []byte("x"))
		_ = os.Chmod(unreadable, 0)
		defer os.Chmod(unreadable, 0o600)
		before := len(peer.messages())
		cases := map[string]struct {
			params map[string]any
			want   string
		}{
			"oversized":           {map[string]any{"path": big}, "too large for Agent Link"},
			"outside the roots":   {map[string]any{"path": filepath.Join(f.outside, "secret.txt")}, "outside file_cache_dir"},
			"a symlink out":       {map[string]any{"path": "file_cache_dir/escape.txt"}, "outside file_cache_dir"},
			"traversal":           {map[string]any{"path": "file_cache_dir/../outside/secret.txt"}, ""},
			"the state dir":       {map[string]any{"path": filepath.Join(f.stateDir, "state.txt")}, "file_state_dir"},
			"a directory":         {map[string]any{"path": "file_cache_dir/folder"}, "directory"},
			"missing":             {map[string]any{"path": "file_cache_dir/none.txt"}, "not found"},
			"with message_base64": {map[string]any{"path": "file_cache_dir/data.bin", "message_base64": "e30"}, "message_base64"},
		}
		if os.Geteuid() != 0 {
			cases["unreadable"] = struct {
				params map[string]any
				want   string
			}{map[string]any{"path": unreadable}, "permission denied"}
		}
		for name, tc := range cases {
			params := map[string]any{"contact_id": peerContact}
			for k, v := range tc.params {
				params[k] = v
			}
			_, err := execAgentSend(t, ctx, f.opts, params)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("%s: error = %v, want %q", name, err, tc.want)
			}
		}
		if after := len(peer.messages()); after != before {
			t.Fatalf("peer got %d messages from refused sends", after-before)
		}
	})

	t.Run("only to active Agent Link agents", func(t *testing.T) {
		store := contacts.NewStore(f.contactsDir)
		if err := store.PutContact(f.ctx, contacts.Contact{ContactID: "tg:@smith_bot", Kind: contacts.KindAgent, Channel: contacts.ChannelTelegram, TGUsername: "smith_bot", TGPrivateChatID: 42}); err != nil {
			t.Fatal(err)
		}
		if _, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": "tg:@smith_bot", "path": "file_cache_dir/data.bin"}); err == nil || !strings.Contains(err.Error(), "only to Agent Link agents") {
			t.Fatalf("telegram agent: error = %v", err)
		}
		if _, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": "mm:inst_00000000000000000000000000000000", "path": "file_cache_dir/data.bin"}); err == nil {
			t.Fatal("unknown agent: no error")
		}
		before := len(peer.messages())
		if _, err := store.SetContactStatus(f.ctx, peerContact, contacts.StatusInactive); err != nil {
			t.Fatal(err)
		}
		defer func() { _, _ = store.SetContactStatus(f.ctx, peerContact, contacts.StatusActive) }()
		if _, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": peerContact, "path": "file_cache_dir/data.bin"}); err == nil || !strings.Contains(err.Error(), "not an active Agent") {
			t.Fatalf("inactive agent: error = %v", err)
		}
		if len(peer.messages()) != before {
			t.Fatal("an inactive agent got the file")
		}
	})

	t.Run("a peer that takes no files gets an explicit error", func(t *testing.T) {
		old := f.peer(t, relay, "Old", false)
		oldContact := agentlink.ContactID(old.node.InstanceID())
		_, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": oldContact, "message_text": "x", "path": "file_cache_dir/data.bin"})
		if err == nil || !errors.Is(err, agentlink.ErrFilesUnsupported) {
			t.Fatalf("error = %v, want ErrFilesUnsupported", err)
		}
		if len(old.messages()) != 0 {
			t.Fatal("the old peer got a message")
		}
		// Text still reaches it.
		if _, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": oldContact, "message_text": "text only"}); err != nil {
			t.Fatal(err)
		}
		if msgs := old.messages(); len(msgs) != 1 || msgs[0].Envelope.Text != "text only" {
			t.Fatalf("old peer got %+v", msgs)
		}
	})

	t.Run("contacts_send carries a file over Agent Link too", func(t *testing.T) {
		// Rewriting the contact clears the cooldown contacts_send keeps.
		if err := contacts.NewStore(f.contactsDir).PutContact(f.ctx, contacts.Contact{ContactID: peerContact, Kind: contacts.KindAgent, Channel: contacts.ChannelAgentLink, ContactNickname: "Peer"}); err != nil {
			t.Fatal(err)
		}
		out, err := NewContactsSendTool(f.opts).Execute(ctx, map[string]any{"contact_id": peerContact, "path": "file_cache_dir/data.bin"})
		if err != nil || !strings.Contains(out, `"accepted": true`) {
			t.Fatalf("contacts_send = %s, %v", out, err)
		}
		msg := peer.messages()[len(peer.messages())-1]
		if len(msg.Attachments) != 1 || msg.Attachments[0].Size != int64(len(binary)) {
			t.Fatalf("peer got %+v", msg)
		}
	})
}

func TestAgentSendAttachesFileToReply(t *testing.T) {
	f := newFileSendFixture(t)
	relay := f.relay(t)
	asker := f.peer(t, relay, "Asker", true)
	other := f.peer(t, relay, "Other", true)
	askerContact := agentlink.ContactID(asker.node.InstanceID())
	data := []byte("report body")
	f.write(t, f.cache, "report.txt", data)
	replyFiles := agentlink.NewReplyFiles(asker.node.InstanceID())
	ctx := agentlink.WithReplyFiles(agentlink.WithIncomingHop(f.ctx, 1), replyFiles)

	result, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": askerContact, "path": "file_cache_dir/report.txt", "message_text": "here"})
	if err != nil {
		t.Fatal(err)
	}
	if result["status"] != "attached_to_reply" || !strings.Contains(result["note"].(string), "message_text is not sent") {
		t.Fatalf("result = %v", result)
	}
	files := replyFiles.Attachments()
	if len(files) != 1 || !bytes.Equal(files[0].Data, data) || files[0].Filename != "report.txt" {
		t.Fatalf("reply files = %+v", files)
	}
	if len(asker.messages()) != 0 {
		t.Fatal("the file went as a message of its own")
	}

	if _, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": askerContact + "," + agentlink.ContactID(other.node.InstanceID()), "path": "file_cache_dir/report.txt"}); err == nil || !strings.Contains(err.Error(), "own agent_send call") {
		t.Fatalf("with another recipient: error = %v", err)
	}
	big := f.write(t, f.cache, "big.bin", make([]byte, agentlink.MaxAttachmentBytes))
	if _, err := execAgentSend(t, ctx, f.opts, map[string]any{"contact_id": askerContact, "path": big}); err == nil || !strings.Contains(err.Error(), "would pass") {
		t.Fatalf("over the answer's limit: error = %v", err)
	}
	if len(replyFiles.Attachments()) != 1 {
		t.Fatal("a refused file was attached")
	}
}
