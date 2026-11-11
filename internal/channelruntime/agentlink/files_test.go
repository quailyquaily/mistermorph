package agentlink

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	link "github.com/quailyquaily/mistermorph/internal/agentlink"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

// promptLLM answers "pong" and keeps every request's messages.
type promptLLM struct {
	mu       sync.Mutex
	requests []string
}

func (p *promptLLM) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	var b strings.Builder
	for _, m := range req.Messages {
		b.WriteString(m.Content)
		b.WriteString("\n")
	}
	p.mu.Lock()
	p.requests = append(p.requests, b.String())
	p.mu.Unlock()
	return llm.Result{Text: `{"type":"final","output":"pong"}`}, nil
}

func (p *promptLLM) seen(text string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, r := range p.requests {
		if strings.Contains(r, text) {
			return true
		}
	}
	return false
}

func TestRunnerTakesFiles(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	deps := testDeps(t)
	model := &promptLLM{}
	deps.CreateLLMClient = func(llmutil.ResolvedRoute) (llm.Client, error) { return model, nil }
	stop := Start(ctx, deps, Options{MaxHops: 3})
	defer stop()
	runner, err := link.Shared(link.Options{StateDir: deps.RuntimePaths.StateDir})
	if err != nil {
		t.Fatal(err)
	}
	sender, err := link.NewNode(link.Options{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	var got replies
	sender.SetHandler(got.handle)
	relay := link.NewRelay(nil)
	connect(ctx, runner, relay, "runner")
	connect(ctx, sender, relay, "sender")
	waitFor(t, "handler", runner.HasHandler)
	waitFor(t, "files", func() bool { return sender.SupportsFiles(runner.InstanceID()) })

	t.Run("a file reaches the task as a local file", func(t *testing.T) {
		data := []byte("col\x00umn,\xffvalue\n")
		attachment, err := link.NewAttachment("data.csv", data)
		if err != nil {
			t.Fatal(err)
		}
		env := busruntime.MessageEnvelope{Text: "summarize the file", SessionID: "0194d8f0-0000-7000-8000-000000000011"}
		res, err := sender.SendWithAttachments(ctx, runner.InstanceID(), env, []link.Attachment{attachment}, 1, 5*time.Second)
		if err != nil || res.Status != link.StatusDelivered {
			t.Fatalf("SendWithAttachments() = %+v, %v", res, err)
		}
		waitFor(t, "reply", func() bool { return len(got.snapshot()) == 1 })
		ref := "file_cache_dir/" + link.InboxDirName + "/" + sender.InstanceID() + "/"
		if !model.seen("summarize the file") || !model.seen("[Agent Link files]") || !model.seen(ref) || !model.seen("data.csv") {
			t.Fatalf("the task was not told about the file: %q", model.requests)
		}
		entries, err := os.ReadDir(filepath.Join(deps.RuntimePaths.CacheDir, link.InboxDirName, sender.InstanceID()))
		if err != nil || len(entries) != 1 {
			t.Fatalf("inbox = %v, %v", entries, err)
		}
		saved, _ := os.ReadFile(filepath.Join(deps.RuntimePaths.CacheDir, link.InboxDirName, sender.InstanceID(), entries[0].Name()))
		if string(saved) != string(data) {
			t.Fatalf("saved %q", saved)
		}
	})

	t.Run("a deactivated agent's file is refused", func(t *testing.T) {
		store := contacts.NewStore(deps.RuntimePaths.ContactsDir)
		contactID := link.ContactID(sender.InstanceID())
		waitFor(t, "contact", func() bool {
			_, ok, err := store.GetContact(ctx, contactID)
			return err == nil && ok
		})
		if _, err := store.SetContactStatus(ctx, contactID, contacts.StatusInactive); err != nil {
			t.Fatal(err)
		}
		attachment, _ := link.NewAttachment("x.txt", []byte("x"))
		env := busruntime.MessageEnvelope{Text: "take this", SessionID: "0194d8f0-0000-7000-8000-000000000012"}
		res, err := sender.SendWithAttachments(ctx, runner.InstanceID(), env, []link.Attachment{attachment}, 1, 5*time.Second)
		if err != nil || res.Status != link.StatusRejected || res.Reason != link.ReasonUnauthorized {
			t.Fatalf("SendWithAttachments() = %+v, %v; want rejected unauthorized", res, err)
		}
		if entries, _ := os.ReadDir(filepath.Join(deps.RuntimePaths.CacheDir, link.InboxDirName, sender.InstanceID())); len(entries) != 1 {
			t.Fatalf("inbox has %d files, want only the earlier one", len(entries))
		}
	})
}

func TestSendReplyWithFiles(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	answerer, err := link.NewNode(link.Options{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer answerer.Close()
	newAsker := func(t *testing.T, withFiles bool) (*link.Node, *replies) {
		asker, err := link.NewNode(link.Options{StateDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(asker.Close)
		if withFiles {
			restore, err := asker.EnableFiles(t.TempDir(), nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(restore)
		}
		var got replies
		asker.SetHandler(got.handle)
		relay := link.NewRelay(nil)
		connect(ctx, answerer, relay, "answerer")
		connect(ctx, asker, relay, "asker")
		waitFor(t, "roster", func() bool { return answerer.Reachable(asker.InstanceID()) })
		return asker, &got
	}
	attachment, _ := link.NewAttachment("answer.txt", []byte("42"))
	question := func(asker *link.Node) job {
		return job{TaskID: "t1", Message: link.Message{MessageID: "msg_q", From: asker.InstanceID(), To: answerer.InstanceID(), Hop: 1,
			Envelope: busruntime.MessageEnvelope{Text: "q", SessionID: "0194d8f0-0000-7000-8000-000000000013"}}}
	}

	t.Run("the answer carries the files", func(t *testing.T) {
		asker, got := newAsker(t, true)
		waitFor(t, "files", func() bool { return answerer.SupportsFiles(asker.InstanceID()) })
		if _, err := sendReply(ctx, answerer, question(asker), "", []link.Attachment{attachment}, logger); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "reply", func() bool { return len(got.snapshot()) == 1 })
		reply := got.snapshot()[0]
		if reply.Envelope.ReplyTo != "msg_q" || len(reply.Attachments) != 1 {
			t.Fatalf("reply = %+v", reply)
		}
		if data, _ := os.ReadFile(reply.Attachments[0].Path); string(data) != "42" {
			t.Fatalf("reply file = %q", data)
		}
	})

	t.Run("an asker that takes no files gets the answer and is told", func(t *testing.T) {
		asker, got := newAsker(t, false)
		if _, err := sendReply(ctx, answerer, question(asker), "the answer", []link.Attachment{attachment}, logger); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "reply", func() bool { return len(got.snapshot()) == 1 })
		reply := got.snapshot()[0]
		if len(reply.Attachments) != 0 || !strings.HasPrefix(reply.Envelope.Text, "the answer") || !strings.Contains(reply.Envelope.Text, `could not be attached to this answer ("answer.txt")`) {
			t.Fatalf("reply = %+v", reply)
		}
	})
}
