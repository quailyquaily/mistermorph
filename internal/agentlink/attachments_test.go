package agentlink

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

// filesNode is a test node that saves received files under a cache dir of its own, as an agent on
// another machine would.
func filesNode(t testing.TB, name string, authorize FileAuthorizer) (*Node, string) {
	t.Helper()
	node := newTestNode(t, name)
	cacheDir := filepath.Join(t.TempDir(), "cache")
	restore, err := node.EnableFiles(cacheDir, authorize)
	if err != nil {
		t.Fatalf("EnableFiles() error = %v", err)
	}
	t.Cleanup(restore)
	return node, cacheDir
}

func mustAttachment(t testing.TB, name string, data []byte) Attachment {
	t.Helper()
	a, err := NewAttachment(name, data)
	if err != nil {
		t.Fatalf("NewAttachment(%q) error = %v", name, err)
	}
	return a
}

func binaryData(t testing.TB, size int) []byte {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	// Every byte value, NULs and invalid UTF-8 included.
	for i := 0; i < 256 && i < size; i++ {
		data[i] = byte(i)
	}
	return data
}

func (i *inbox) last() Message {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.msgs[len(i.msgs)-1]
}

// inboxFiles lists every file under dir, partial ones included.
func inboxFiles(t testing.TB, dir string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			out = append(out, path)
		}
		return nil
	})
	return out
}

func linked(t testing.TB, ctx context.Context, nodes ...*Node) *Relay {
	t.Helper()
	relay := NewRelay(nil)
	for i, node := range nodes {
		attach(t, ctx, node, relay, string(rune('a'+i)))
	}
	for _, a := range nodes {
		for _, b := range nodes {
			if a != b {
				waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
			}
		}
	}
	return relay
}

func TestAttachmentTransfer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := newTestNode(t, "A")
	b, bCache := filesNode(t, "B", nil)
	var got inbox
	b.SetHandler(got.handler(nil))
	linked(t, ctx, a, b)
	if !a.SupportsFiles(b.InstanceID()) {
		t.Fatal("a does not see that b takes files")
	}

	cases := []struct {
		name, filename, text string
		data                 []byte
		mediaType            string
	}{
		{name: "binary file with text", filename: "报告 v1.bin", text: "here is the data", data: binaryData(t, 300<<10), mediaType: "application/octet-stream"},
		{name: "empty file without text", filename: "empty.txt", data: []byte{}, mediaType: "text/plain"},
		{name: "largest file", filename: "max.png", data: binaryData(t, int(MaxAttachmentBytes)), mediaType: "image/png"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			attachment := mustAttachment(t, tc.filename, tc.data)
			res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(tc.text), []Attachment{attachment}, 1, 5*time.Second)
			if err != nil || res.Status != StatusDelivered {
				t.Fatalf("SendWithAttachments() = %+v, %v; want delivered", res, err)
			}
			msg := got.last()
			if msg.Envelope.Text != tc.text || len(msg.Attachments) != 1 {
				t.Fatalf("delivered = %+v", msg)
			}
			received := msg.Attachments[0]
			if received.Filename != tc.filename || received.Size != int64(len(tc.data)) || received.SHA256 != attachment.SHA256 || !strings.HasPrefix(received.MediaType, tc.mediaType) {
				t.Fatalf("metadata = %+v, want %q %d %s %s", received, tc.filename, len(tc.data), attachment.SHA256, tc.mediaType)
			}
			if received.Data != nil {
				t.Fatal("received attachment still holds its bytes")
			}
			wantDir := filepath.Join(bCache, InboxDirName, a.InstanceID())
			resolvedDir, _ := filepath.EvalSymlinks(wantDir)
			if filepath.Dir(received.Path) != resolvedDir || !strings.HasPrefix(received.Ref, "file_cache_dir/"+InboxDirName+"/"+a.InstanceID()+"/") {
				t.Fatalf("saved at %q (%q), want in %q", received.Path, received.Ref, wantDir)
			}
			saved, err := os.ReadFile(received.Path)
			if err != nil || !bytes.Equal(saved, tc.data) {
				t.Fatalf("saved bytes differ (%d of %d bytes): %v", len(saved), len(tc.data), err)
			}
			info, _ := os.Stat(received.Path)
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("saved mode = %v, want 0600", info.Mode().Perm())
			}
			dirInfo, _ := os.Stat(resolvedDir)
			if dirInfo.Mode().Perm() != 0o700 {
				t.Fatalf("inbox dir mode = %v, want 0700", dirInfo.Mode().Perm())
			}
		})
	}

	t.Run("the same file twice gets two names", func(t *testing.T) {
		attachment := mustAttachment(t, "same.txt", []byte("one"))
		for i := 0; i < 2; i++ {
			if res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope("again"), []Attachment{attachment}, 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
				t.Fatalf("send %d = %+v, %v", i, res, err)
			}
		}
		msgs := got.msgs[len(got.msgs)-2:]
		if msgs[0].Attachments[0].Path == msgs[1].Attachments[0].Path {
			t.Fatal("the second file replaced the first")
		}
	})

	t.Run("a redelivered message saves nothing again", func(t *testing.T) {
		before := len(inboxFiles(t, bCache))
		attachment := mustAttachment(t, "dup.txt", []byte("dup"))
		msg := Message{MessageID: "msg_dup", From: a.InstanceID(), To: b.InstanceID(), Hop: 1, Envelope: envelope(""), Attachments: []Attachment{attachment}}
		for i := 0; i < 2; i++ {
			if status, reason := deliverDirect(t, ctx, b, msg); status != StatusAccepted {
				t.Fatalf("delivery %d = %s %s", i, status, reason)
			}
		}
		if after := len(inboxFiles(t, bCache)); after != before+1 {
			t.Fatalf("inbox has %d files, want %d", after, before+1)
		}
	})
}

func TestAttachmentOverWebSocket(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := newTestNode(t, "A")
	b, _ := filesNode(t, "B", nil)
	var got inbox
	b.SetHandler(got.handler(nil))
	const token = "secret"
	server := httptest.NewServer(b.WebSocketHandler(func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer "+token }))
	defer server.Close()
	conn, err := Dial(ctx, server.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	relay := NewRelay(nil)
	go func() { _ = relay.Serve(ctx, conn, "remote") }()
	attach(t, ctx, a, relay, "local")
	waitFor(t, "files over the websocket", func() bool { return a.SupportsFiles(b.InstanceID()) })
	// Larger than the 1 MiB frames of earlier versions once encoded.
	data := binaryData(t, int(MaxAttachmentBytes))
	res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope("big"), []Attachment{mustAttachment(t, "big.bin", data)}, 1, 10*time.Second)
	if err != nil || res.Status != StatusDelivered {
		t.Fatalf("SendWithAttachments() = %+v, %v", res, err)
	}
	saved, _ := os.ReadFile(got.last().Attachments[0].Path)
	if !bytes.Equal(saved, data) {
		t.Fatal("bytes changed over the websocket")
	}
}

func TestAttachmentInReply(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, aCache := filesNode(t, "A", func(context.Context, string) error { return errors.New("only answers") })
	b, _ := filesNode(t, "B", nil)
	b.SetHandler(func(_ context.Context, msg Message) error {
		go func() {
			answer := mustAttachment(t, "answer.csv", []byte("a,b\n1,2\n"))
			_, _ = b.SendWithAttachments(context.Background(), msg.From, busEnvelopeReply("see file", msg), []Attachment{answer}, msg.Hop+1, 0)
		}()
		return nil
	})
	linked(t, ctx, a, b)
	replies, stop := a.ExpectReply("msg_question", b.InstanceID(), Origin{})
	defer stop()
	question := envelope("send me the table")
	question.MessageID = "msg_question"
	if res, err := a.Send(ctx, b.InstanceID(), question, 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
		t.Fatalf("Send() = %+v, %v", res, err)
	}
	select {
	case reply := <-replies:
		if reply.Envelope.Text != "see file" || len(reply.Attachments) != 1 {
			t.Fatalf("reply = %+v", reply)
		}
		got := reply.Attachments[0]
		data, err := os.ReadFile(got.Path)
		if err != nil || string(data) != "a,b\n1,2\n" || got.Filename != "answer.csv" || !strings.HasPrefix(got.MediaType, "text/csv") {
			t.Fatalf("reply attachment = %+v, %q, %v", got, data, err)
		}
		resolved, _ := filepath.EvalSymlinks(aCache)
		if !strings.HasPrefix(got.Path, resolved+string(filepath.Separator)) {
			t.Fatalf("reply saved at %q, outside %q", got.Path, resolved)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no reply")
	}
}

func busEnvelopeReply(text string, to Message) (e busruntime.MessageEnvelope) {
	e = envelope(text)
	e.ReplyTo = to.MessageID
	e.SessionID = to.Envelope.SessionID
	return e
}

func TestAttachmentNames(t *testing.T) {
	for raw, want := range map[string]string{
		"report.pdf":             "report.pdf",
		"../../etc/passwd":       "passwd",
		`..\..\boot.ini`:         "boot.ini",
		"/abs/path/x.sh":         "x.sh",
		"..":                     "",
		".":                      "",
		"dir/":                   "",
		"bell\x07\nname.txt":     "bellname.txt",
		"invoice\u202Etxt.exe":   "invoicetxt.exe",
		"  spaced  ":             "spaced",
		"日本語 ファイル.txt":           "日本語 ファイル.txt",
		strings.Repeat("é", 200): strings.Repeat("é", 127),
	} {
		if got := CleanAttachmentName(raw); got != want {
			t.Errorf("CleanAttachmentName(%q) = %q, want %q", raw, got, want)
		}
	}
	if _, err := NewAttachment("..", []byte("x")); err == nil {
		t.Error("NewAttachment(\"..\") succeeded")
	}
	if a := mustAttachment(t, "../../.bashrc", []byte("x")); a.Filename != ".bashrc" {
		t.Errorf("filename = %q", a.Filename)
	}
	if got := NormalizeMediaType("text/html; charset=utf-8"); got != "text/html" {
		t.Errorf("NormalizeMediaType() = %q", got)
	}
	if got := NormalizeMediaType("not a type"); got != "application/octet-stream" {
		t.Errorf("NormalizeMediaType() = %q", got)
	}
}

func TestAttachmentValidation(t *testing.T) {
	good := mustAttachment(t, "a.txt", []byte("hello"))
	base := Message{MessageID: "m1", From: newTestNode(t, "A").InstanceID(), To: newTestNode(t, "B").InstanceID(), Hop: 1}
	mutate := func(fn func(*Attachment)) []Attachment {
		a := good
		a.Data = append([]byte(nil), good.Data...)
		fn(&a)
		return []Attachment{a}
	}
	cases := map[string][]Attachment{
		"traversal name":   mutate(func(a *Attachment) { a.Filename = "../a.txt" }),
		"empty name":       mutate(func(a *Attachment) { a.Filename = "" }),
		"control name":     mutate(func(a *Attachment) { a.Filename = "a\n.txt" }),
		"size mismatch":    mutate(func(a *Attachment) { a.Size = 4 }),
		"digest mismatch":  mutate(func(a *Attachment) { a.Data[0] = 'H' }),
		"bad digest":       mutate(func(a *Attachment) { a.SHA256 = "zz" }),
		"bad media type":   mutate(func(a *Attachment) { a.MediaType = "text/plain; x=1" }),
		"too many":         {good, good, good, good, good},
		"too large in all": {mustAttachment(t, "1", make([]byte, MaxAttachmentBytes)), mustAttachment(t, "2", []byte("x"))},
		"negative size":    mutate(func(a *Attachment) { a.Size = -1 }),
	}
	for name, attachments := range cases {
		msg := base
		msg.Attachments = attachments
		if err := msg.Validate(); err == nil {
			t.Errorf("%s: Validate() succeeded", name)
		}
	}
	msg := base
	msg.Attachments = []Attachment{good}
	if err := msg.Validate(); err != nil {
		t.Errorf("a file without text: Validate() = %v", err)
	}
	if _, err := NewAttachment("big.bin", make([]byte, MaxAttachmentBytes+1)); err == nil {
		t.Error("NewAttachment() over the limit succeeded")
	}
}

func TestReadAttachmentFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.bin")
	if err := os.WriteFile(path, []byte{0, 1, 2}, 0o600); err != nil {
		t.Fatal(err)
	}
	a, err := ReadAttachmentFile(path, "shown.bin", -1, "")
	if err != nil || a.Filename != "shown.bin" || a.Size != 3 {
		t.Fatalf("ReadAttachmentFile() = %+v, %v", a, err)
	}
	if _, err := ReadAttachmentFile(path, "shown.bin", 3, strings.Repeat("0", 64)); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("a changed file: error = %v", err)
	}
	big := filepath.Join(dir, "big.bin")
	f, _ := os.Create(big)
	_ = f.Truncate(MaxAttachmentBytes + 1)
	_ = f.Close()
	if _, err := ReadAttachmentFile(big, "big.bin", -1, ""); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("an oversized file: error = %v", err)
	}
	if _, err := ReadAttachmentFile(dir, "dir", -1, ""); err == nil {
		t.Fatal("a directory was read")
	}
	if _, err := ReadAttachmentFile(filepath.Join(dir, "missing"), "x", -1, ""); err == nil {
		t.Fatal("a missing file was read")
	}
}

func TestAttachmentLimits(t *testing.T) {
	ctx := context.Background()

	t.Run("the outbox holds a bounded amount of file bytes", func(t *testing.T) {
		a := newTestNode(t, "A")
		// The real bound is 512 MiB on disk; a smaller one shows the same behavior.
		a.maxQueuedFileBytes = 4 * MaxAttachmentBytes
		offline := newTestNode(t, "B").InstanceID()
		big := mustAttachment(t, "big.bin", make([]byte, MaxAttachmentBytes))
		for i := int64(0); i < a.maxQueuedFileBytes/MaxAttachmentBytes; i++ {
			if res, err := a.SendWithAttachments(ctx, offline, envelope(""), []Attachment{big}, 1, 0); err != nil || res.Status != StatusQueued {
				t.Fatalf("send %d = %+v, %v", i, res, err)
			}
		}
		if _, err := a.SendWithAttachments(ctx, offline, envelope(""), []Attachment{big}, 1, 0); !errors.Is(err, ErrFileQueueFull) {
			t.Fatalf("send over the bound: error = %v, want ErrFileQueueFull", err)
		}
		// Text still goes.
		if res, err := a.Send(ctx, offline, envelope("text"), 1, 0); err != nil || res.Status != StatusQueued {
			t.Fatalf("text send = %+v, %v", res, err)
		}
	})

	t.Run("a message too large for a frame is refused", func(t *testing.T) {
		a := newTestNode(t, "A")
		e := envelope(strings.Repeat("x", maxFrameSize))
		_, err := a.SendWithAttachments(ctx, newTestNode(t, "B").InstanceID(), e, []Attachment{mustAttachment(t, "a", []byte("a"))}, 1, 0)
		if err == nil || !strings.Contains(err.Error(), "too large") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("the relay bounds the inline file bytes in flight", func(t *testing.T) {
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		a := newTestNode(t, "A")
		// A peer that does not stream gets its files inline.
		b := oldFilesNode(t, "B")
		var got inbox
		b.SetHandler(got.handler(nil))
		relay := linked(t, runCtx, a, b)
		relay.mu.Lock()
		relay.maxFileBytes = 10
		relay.mu.Unlock()
		res, err := a.SendWithAttachments(runCtx, b.InstanceID(), envelope(""), []Attachment{mustAttachment(t, "a.bin", make([]byte, 11))}, 1, 300*time.Millisecond)
		if err != nil || res.Status != StatusQueued || got.count() != 0 {
			t.Fatalf("over the relay bound: %+v, %v, %d delivered; want queued", res, err, got.count())
		}
		relay.mu.Lock()
		relay.maxFileBytes = maxRelayAttachmentBytes
		held := relay.fileBytes
		relay.mu.Unlock()
		if held != 0 {
			t.Fatalf("relay holds %d file bytes after refusing", held)
		}
		waitFor(t, "delivery once the relay has room", func() bool { return got.count() == 1 })
		waitFor(t, "relay released the bytes", func() bool {
			relay.mu.Lock()
			defer relay.mu.Unlock()
			return relay.fileBytes == 0
		})
	})

	t.Run("an expired file leaves the queue", func(t *testing.T) {
		node, err := NewNode(Options{StateDir: t.TempDir(), QueueTTL: 50 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		defer node.Close()
		res, err := node.SendWithAttachments(ctx, newTestNode(t, "B").InstanceID(), envelope(""), []Attachment{mustAttachment(t, "a.bin", make([]byte, MaxAttachmentBytes))}, 1, 3*time.Second)
		if err != nil || res.Status != StatusExpired {
			t.Fatalf("SendWithAttachments() = %+v, %v; want expired", res, err)
		}
		node.mu.Lock()
		queued := node.queuedFileBytes
		node.mu.Unlock()
		if queued != 0 {
			t.Fatalf("queued file bytes = %d after expiry", queued)
		}
		if entries, _ := os.ReadDir(node.outboxDir()); len(entries) != 0 {
			t.Fatalf("outbox keeps %d entries after expiry", len(entries))
		}
	})

	t.Run("a queued file survives a restart intact", func(t *testing.T) {
		dir := t.TempDir()
		node, err := NewNode(Options{StateDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := filesNode(t, "B", nil)
		data := binaryData(t, 4096)
		if _, err := node.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{mustAttachment(t, "kept.bin", data)}, 1, 0); err != nil {
			t.Fatal(err)
		}
		node.Close()
		reopened, err := NewNode(Options{StateDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		if reopened.queuedFileBytes != int64(len(data)) {
			t.Fatalf("queued file bytes after restart = %d", reopened.queuedFileBytes)
		}
		var got inbox
		b.SetHandler(got.handler(nil))
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		linked(t, runCtx, reopened, b)
		waitFor(t, "delivery after restart", func() bool { return got.count() == 1 })
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, data) {
			t.Fatal("bytes changed across the restart")
		}
	})
}

func TestAttachmentUnsupportedPeers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	file := []Attachment{mustAttachment(t, "a.txt", []byte("a"))}

	t.Run("a runtime that takes no files", func(t *testing.T) {
		a := newTestNode(t, "A")
		old := newTestNode(t, "Old")
		var got inbox
		old.SetHandler(got.handler(nil))
		linked(t, ctx, a, old)
		if a.SupportsFiles(old.InstanceID()) {
			t.Fatal("a peer without files is listed as taking them")
		}
		if _, err := a.SendWithAttachments(ctx, old.InstanceID(), envelope("x"), file, 1, time.Second); !errors.Is(err, ErrFilesUnsupported) {
			t.Fatalf("error = %v, want ErrFilesUnsupported", err)
		}
		// Text still goes to it.
		if res, err := a.Send(ctx, old.InstanceID(), envelope("text"), 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
			t.Fatalf("text = %+v, %v", res, err)
		}
		if got.count() != 1 || len(got.last().Attachments) != 0 {
			t.Fatalf("old peer got %+v", got.msgs)
		}
	})

	t.Run("a Console that predates files", func(t *testing.T) {
		a := newTestNode(t, "A")
		peer, _ := filesNode(t, "B", nil)
		console := oldConsole(t, ctx, a)
		// An old Console lists peers without capabilities.
		if err := console.WriteFrame(ctx, Frame{Type: FrameRoster, Agents: []Peer{{InstanceID: peer.InstanceID(), AgentName: "B"}}}); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "roster", func() bool { return a.Reachable(peer.InstanceID()) })
		if _, err := a.SendWithAttachments(ctx, peer.InstanceID(), envelope("x"), file, 1, time.Second); !errors.Is(err, ErrFilesUnsupported) {
			t.Fatalf("error = %v, want ErrFilesUnsupported", err)
		}
	})

	t.Run("a queued file finds only an old Console", func(t *testing.T) {
		a := newTestNode(t, "A")
		peer := newTestNode(t, "B")
		results := make(chan SendResult, 1)
		go func() {
			res, _ := a.SendWithAttachments(ctx, peer.InstanceID(), envelope("x"), file, 1, 5*time.Second)
			results <- res
		}()
		waitFor(t, "queued", func() bool {
			a.mu.Lock()
			defer a.mu.Unlock()
			return len(a.outbox) == 1
		})
		console := oldConsole(t, ctx, a)
		if err := console.WriteFrame(ctx, Frame{Type: FrameRoster, Agents: []Peer{{InstanceID: peer.InstanceID()}}}); err != nil {
			t.Fatal(err)
		}
		select {
		case res := <-results:
			if res.Status != StatusRejected || res.Reason != ReasonFilesUnsupported {
				t.Fatalf("result = %+v, want rejected files_unsupported", res)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no result")
		}
	})

	t.Run("the relay refuses files for a peer that takes none", func(t *testing.T) {
		relay := NewRelay(nil)
		old := newTestNode(t, "Old")
		var got inbox
		old.SetHandler(got.handler(nil))
		attach(t, ctx, old, relay, "old")
		waitMember(t, relay, old.InstanceID())
		// A runtime that ignores the roster and sends anyway.
		sender := fakeRuntime(t, ctx, relay, newTestNode(t, "Rogue").InstanceID(), []string{CapabilityFiles})
		msg := Message{MessageID: "m1", From: sender.id, To: old.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: file}
		status, reason := sender.send(t, ctx, msg)
		if status != StatusRejected || reason != ReasonFilesUnsupported || got.count() != 0 {
			t.Fatalf("relay result = %s %s, delivered %d; want rejected files_unsupported", status, reason, got.count())
		}
	})

	t.Run("a runtime without an inbox rejects files it is handed", func(t *testing.T) {
		old := newTestNode(t, "Old")
		old.SetHandler((&inbox{}).handler(nil))
		msg := Message{MessageID: "m2", From: newTestNode(t, "A").InstanceID(), To: old.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: file}
		if status, reason := deliverDirect(t, ctx, old, msg); status != StatusRejected || reason != ReasonFilesUnsupported {
			t.Fatalf("result = %s %s", status, reason)
		}
	})
}

func TestAttachmentTrustBoundaries(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	file := []Attachment{mustAttachment(t, "a.txt", []byte("a"))}

	t.Run("the relay sends as the connected runtime only", func(t *testing.T) {
		relay := NewRelay(nil)
		b, _ := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		attach(t, ctx, b, relay, "b")
		waitMember(t, relay, b.InstanceID())
		rogue := fakeRuntime(t, ctx, relay, newTestNode(t, "Rogue").InstanceID(), []string{CapabilityFiles})
		victim := newTestNode(t, "Victim").InstanceID()
		msg := Message{MessageID: "m1", From: victim, To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: file}
		if status, _ := rogue.send(t, ctx, msg); status != StatusDelivered {
			t.Fatalf("status = %s", status)
		}
		if from := got.last().From; from != rogue.id {
			t.Fatalf("delivered from %s, want the sending runtime %s", from, rogue.id)
		}
		if !strings.Contains(got.last().Attachments[0].Path, rogue.id) {
			t.Fatalf("saved at %s, not under the real sender", got.last().Attachments[0].Path)
		}
	})

	t.Run("the relay refuses a forged attachment", func(t *testing.T) {
		relay := NewRelay(nil)
		b, bCache := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		attach(t, ctx, b, relay, "b")
		waitMember(t, relay, b.InstanceID())
		rogue := fakeRuntime(t, ctx, relay, newTestNode(t, "Rogue").InstanceID(), []string{CapabilityFiles})
		bad := mustAttachment(t, "evil.sh", []byte("#!/bin/sh\nrm -rf ~\n"))
		bad.Filename = "../../.bashrc"
		msg := Message{MessageID: "m2", From: rogue.id, To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: []Attachment{bad}}
		if status, reason := rogue.send(t, ctx, msg); status != StatusRejected || reason != ReasonInvalid {
			t.Fatalf("result = %s %s, want rejected invalid", status, reason)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 || got.count() != 0 {
			t.Fatalf("files = %v, delivered = %d", files, got.count())
		}
	})

	t.Run("the node checks every delivery itself", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		from := newTestNode(t, "A").InstanceID()
		tampered := mustAttachment(t, "a.bin", []byte("original"))
		tampered.Data = []byte("tampered")
		traversal := mustAttachment(t, "a.bin", []byte("x"))
		traversal.Filename = "../escape.bin"
		for name, msg := range map[string]Message{
			"digest":       {MessageID: "d1", From: from, To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: []Attachment{tampered}},
			"traversal":    {MessageID: "d2", From: from, To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: []Attachment{traversal}},
			"other target": {MessageID: "d3", From: from, To: from, Hop: 1, Envelope: envelope("x"), Attachments: file},
		} {
			if status, reason := deliverDirect(t, ctx, b, msg); status != StatusRejected || reason != ReasonInvalid {
				t.Errorf("%s: result = %s %s, want rejected invalid", name, status, reason)
			}
		}
		if files := inboxFiles(t, bCache); len(files) != 0 || got.count() != 0 {
			t.Fatalf("files = %v, delivered = %d", files, got.count())
		}
	})

	t.Run("an unauthorized sender's file is refused", func(t *testing.T) {
		b, bCache := filesNode(t, "B", func(_ context.Context, from string) error { return errors.New("blocked " + from) })
		var got inbox
		b.SetHandler(got.handler(nil))
		msg := Message{MessageID: "u1", From: newTestNode(t, "A").InstanceID(), To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: file}
		if status, reason := deliverDirect(t, ctx, b, msg); status != StatusRejected || reason != ReasonUnauthorized {
			t.Fatalf("result = %s %s, want rejected unauthorized", status, reason)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 || got.count() != 0 {
			t.Fatalf("files = %v, delivered = %d", files, got.count())
		}
		// Text from the same agent is not a file and goes through as before.
		text := Message{MessageID: "u2", From: msg.From, To: b.InstanceID(), Hop: 1, Envelope: envelope("x")}
		if status, _ := deliverDirect(t, ctx, b, text); status != StatusAccepted {
			t.Fatalf("text status = %s", status)
		}
	})

	t.Run("a rejected message leaves no file", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(&RejectError{Reason: ReasonHopLimit}))
		msg := Message{MessageID: "r1", From: newTestNode(t, "A").InstanceID(), To: b.InstanceID(), Hop: 9, Envelope: envelope("x"), Attachments: file}
		if status, reason := deliverDirect(t, ctx, b, msg); status != StatusRejected || reason != ReasonHopLimit {
			t.Fatalf("result = %s %s", status, reason)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 {
			t.Fatalf("files = %v", files)
		}
	})

	t.Run("a symlink in the inbox is refused", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(nil))
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(bCache, InboxDirName)); err != nil {
			t.Fatal(err)
		}
		msg := Message{MessageID: "s1", From: newTestNode(t, "A").InstanceID(), To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: file}
		if status, reason := deliverDirect(t, ctx, b, msg); status != StatusRejected || reason != ReasonAttachmentStore {
			t.Fatalf("result = %s %s, want rejected attachment_store_failed", status, reason)
		}
		if files := inboxFiles(t, outside); len(files) != 0 {
			t.Fatalf("wrote through the symlink: %v", files)
		}
	})

	t.Run("a symlink for the sender's folder is refused", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(nil))
		from := newTestNode(t, "A").InstanceID()
		outside := t.TempDir()
		if err := os.MkdirAll(filepath.Join(bCache, InboxDirName), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(bCache, InboxDirName, from)); err != nil {
			t.Fatal(err)
		}
		msg := Message{MessageID: "s2", From: from, To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: file}
		if status, _ := deliverDirect(t, ctx, b, msg); status != StatusRejected {
			t.Fatalf("status = %s", status)
		}
		if files := inboxFiles(t, outside); len(files) != 0 {
			t.Fatalf("wrote through the symlink: %v", files)
		}
	})
}

func TestAttachmentInterrupted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	t.Run("a write that fails midway publishes nothing", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		previous := writeAttachmentData
		writeAttachmentData = func(f *os.File, data []byte) error {
			_, _ = f.Write(data[:len(data)/2])
			return errors.New("disk went away")
		}
		defer func() { writeAttachmentData = previous }()
		msg := Message{MessageID: "i1", From: newTestNode(t, "A").InstanceID(), To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: []Attachment{
			mustAttachment(t, "first.bin", []byte("0123456789")),
		}}
		if status, reason := deliverDirect(t, ctx, b, msg); status != StatusRejected || reason != ReasonAttachmentStore {
			t.Fatalf("result = %s %s", status, reason)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 || got.count() != 0 {
			t.Fatalf("files = %v, delivered = %d", files, got.count())
		}
	})

	t.Run("a second file failing removes the first", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(nil))
		previous := writeAttachmentData
		calls := 0
		writeAttachmentData = func(f *os.File, data []byte) error {
			calls++
			if calls == 2 {
				return errors.New("interrupted")
			}
			return previous(f, data)
		}
		defer func() { writeAttachmentData = previous }()
		msg := Message{MessageID: "i2", From: newTestNode(t, "A").InstanceID(), To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: []Attachment{
			mustAttachment(t, "first.bin", []byte("1")), mustAttachment(t, "second.bin", []byte("2")),
		}}
		if status, _ := deliverDirect(t, ctx, b, msg); status != StatusRejected {
			t.Fatalf("status = %s", status)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 {
			t.Fatalf("files = %v", files)
		}
	})

	t.Run("a target that drops mid-delivery is not reported delivered", func(t *testing.T) {
		relay := NewRelay(nil)
		a := newTestNode(t, "A")
		b, _ := filesNode(t, "B", nil)
		release := make(chan struct{})
		b.SetHandler(func(ctx context.Context, msg Message) error {
			<-release
			return nil
		})
		attach(t, ctx, a, relay, "a")
		disconnect, _ := attach(t, ctx, b, relay, "b")
		waitFor(t, "roster", func() bool { return a.SupportsFiles(b.InstanceID()) })
		results := make(chan SendResult, 1)
		go func() {
			res, _ := a.SendWithAttachments(ctx, b.InstanceID(), envelope("x"), []Attachment{mustAttachment(t, "a.bin", []byte("abc"))}, 1, 500*time.Millisecond)
			results <- res
		}()
		time.Sleep(100 * time.Millisecond)
		disconnect()
		res := <-results
		a.mu.Lock()
		_, queued := a.outbox[res.MessageID]
		a.mu.Unlock()
		close(release)
		if res.Status == StatusDelivered {
			t.Fatalf("result = %+v, want not delivered", res)
		}
		if !queued {
			t.Fatal("the interrupted message left the queue")
		}
		// The receiver finishes the delivery it was handed (and writes its state) before the test
		// removes its folders.
		waitFor(t, "the receiver finished", func() bool {
			b.mu.Lock()
			defer b.mu.Unlock()
			return len(b.inflight) == 0 && len(b.inStreams) == 0
		})
	})

	t.Run("cleanup removes stale partial files and bounds the inbox", func(t *testing.T) {
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(nil))
		from := newTestNode(t, "A").InstanceID()
		dir := filepath.Join(bCache, InboxDirName, from)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		stale := filepath.Join(dir, partialFilePrefix+"stale")
		fresh := filepath.Join(dir, partialFilePrefix+"fresh")
		old := filepath.Join(dir, "old-file.txt")
		for _, p := range []string{stale, fresh, old} {
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		_ = os.Chtimes(stale, time.Now().Add(-2*partialFileMaxAge), time.Now().Add(-2*partialFileMaxAge))
		_ = os.Chtimes(old, time.Now().Add(-2*inboxMaxAge), time.Now().Add(-2*inboxMaxAge))
		msg := Message{MessageID: "c1", From: from, To: b.InstanceID(), Hop: 1, Envelope: envelope("x"), Attachments: []Attachment{mustAttachment(t, "new.txt", []byte("n"))}}
		if status, _ := deliverDirect(t, ctx, b, msg); status != StatusAccepted {
			t.Fatalf("status = %s", status)
		}
		for path, want := range map[string]bool{stale: false, fresh: true, old: false} {
			if _, err := os.Stat(path); (err == nil) != want {
				t.Errorf("%s exists = %v, want %v", filepath.Base(path), err == nil, want)
			}
		}
	})
}

// deliverDirect hands node msg as a Console would and returns its deliver_result.
func deliverDirect(t *testing.T, ctx context.Context, node *Node, msg Message) (string, string) {
	t.Helper()
	console := oldConsole(t, ctx, node)
	if err := console.WriteFrame(ctx, Frame{Type: FrameDeliver, MessageID: msg.MessageID, Message: &msg}); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		frame, err := console.ReadFrame(readCtx)
		if err != nil {
			t.Fatalf("no deliver_result: %v", err)
		}
		if frame.Type == FrameDeliverResult && frame.MessageID == msg.MessageID {
			return frame.Status, frame.Reason
		}
	}
}

// oldConsole connects to node as a Console that lists peers itself, and has read the hello.
func oldConsole(t *testing.T, ctx context.Context, node *Node) Conn {
	t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	runtimeEnd, console := Pipe()
	go func() { _ = node.Serve(ctx, runtimeEnd) }()
	if frame, err := console.ReadFrame(ctx); err != nil || frame.Type != FrameHello {
		t.Fatalf("hello = %+v, %v", frame, err)
	}
	return console
}

type rogueRuntime struct {
	id   string
	conn Conn
}

// fakeRuntime connects to relay as a runtime that sends whatever a test gives it.
func fakeRuntime(t *testing.T, ctx context.Context, relay *Relay, id string, capabilities []string) *rogueRuntime {
	t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	runtimeEnd, relayEnd := Pipe()
	go func() { _ = relay.Serve(ctx, relayEnd, "rogue") }()
	if err := runtimeEnd.WriteFrame(ctx, Frame{Type: FrameHello, InstanceID: id, Capabilities: capabilities}); err != nil {
		t.Fatal(err)
	}
	return &rogueRuntime{id: id, conn: runtimeEnd}
}

func (r *rogueRuntime) send(t *testing.T, ctx context.Context, msg Message) (string, string) {
	t.Helper()
	if err := r.conn.WriteFrame(ctx, Frame{Type: FrameSend, LeaseID: "lease", MessageID: msg.MessageID, Message: &msg}); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		frame, err := r.conn.ReadFrame(readCtx)
		if err != nil {
			t.Fatalf("no send_result: %v", err)
		}
		if frame.Type == FrameSendResult && frame.MessageID == msg.MessageID {
			return frame.Status, frame.Reason
		}
	}
}

func waitMember(t *testing.T, relay *Relay, id string) {
	t.Helper()
	waitFor(t, "relay member "+id, func() bool {
		for _, peer := range relay.Members() {
			if peer.InstanceID == id {
				return true
			}
		}
		return false
	})
}
