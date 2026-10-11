package socialpost

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type stubLLM struct{ answer string }

func (s stubLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{Text: `{"type":"final","output":` + quote(s.answer) + `}`}, nil
}

func quote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

type mapReader map[string]string

func (m mapReader) GetString(key string) string { return m[key] }

func testDeps(t *testing.T, answer string) depsutil.CommonDependencies {
	t.Helper()
	paths := runtimepaths.FromReader(mapReader{"file_state_dir": t.TempDir(), "file_cache_dir": t.TempDir()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return logger, nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return llmutil.ResolvedRoute{}, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return stubLLM{answer: answer}, nil },
		Registry:        func() *tools.Registry { return tools.NewRegistry() },
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
		RuntimePaths: paths,
	}
}

// fakeSource delivers the posts it is given and records the replies.
type fakeSource struct {
	posts chan Post

	mu      sync.Mutex
	replies map[string][]string
	thread  []Post
}

func newFakeSource() *fakeSource {
	return &fakeSource{posts: make(chan Post, 16), replies: map[string][]string{}}
}

func (s *fakeSource) Run(ctx context.Context, deliver func(context.Context, Post) error) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case post := <-s.posts:
			_ = deliver(ctx, post)
		}
	}
}

func (s *fakeSource) Thread(context.Context, Post, int) ([]Post, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Post(nil), s.thread...), nil
}

func (s *fakeSource) Reply(_ context.Context, post Post, parts []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replies[post.ID] = append([]string(nil), parts...)
	return nil
}

func (s *fakeSource) Split(text string, maxPosts int) []string {
	var parts []string
	for len(text) > 0 && len(parts) < maxPosts {
		n := min(len(text), 10)
		parts = append(parts, text[:n])
		text = text[n:]
	}
	return parts
}

func (s *fakeSource) SelfID() string { return "self" }

func (s *fakeSource) reply(id string) ([]string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	parts, ok := s.replies[id]
	return parts, ok
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func start(t *testing.T, answer string, opts Options) (*fakeSource, *state) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	deps := testDeps(t, answer)
	source := newFakeSource()
	opts.Channel = "testnet"
	opts.Source = source
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = Run(ctx, deps, opts)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return source, newState(deps.RuntimePaths.StateDir, "testnet", time.Now)
}

func post(id, author, text string) Post {
	return Post{ID: id, ThreadID: "root", AuthorID: author, AuthorHandle: author, Text: text, CreatedAt: time.Now()}
}

func TestRuntimeAnswersMentions(t *testing.T) {
	source, _ := start(t, "the answer is forty-two", Options{MaxReplyPosts: 2})

	t.Run("answers in the thread, split and cut to max posts", func(t *testing.T) {
		source.posts <- post("p1", "alice", "@agent what is the answer?")
		waitFor(t, "reply", func() bool { _, ok := source.reply("p1"); return ok })
		parts, _ := source.reply("p1")
		if len(parts) != 2 || parts[0] != "the answer" || parts[1] != " is forty-" {
			t.Fatalf("reply = %q", parts)
		}
	})

	t.Run("skips bots, itself and empty mentions", func(t *testing.T) {
		bot := post("p2", "robot", "@agent hi")
		bot.AuthorIsBot = true
		source.posts <- bot
		source.posts <- post("p3", "self", "@agent note to self")
		source.posts <- post("p4", "bob", "@agent @carol")
		source.posts <- post("p5", "bob", "@agent marker")
		waitFor(t, "the marker reply", func() bool { _, ok := source.reply("p5"); return ok })
		for _, id := range []string{"p2", "p3", "p4"} {
			if _, ok := source.reply(id); ok {
				t.Fatalf("%s was answered", id)
			}
		}
	})

	t.Run("stop opts out until start", func(t *testing.T) {
		source.posts <- post("p6", "dave", "@agent stop")
		source.posts <- post("p7", "dave", "@agent are you there?")
		source.posts <- post("p8", "dave", "@agent START")
		source.posts <- post("p9", "dave", "@agent back again")
		waitFor(t, "the reply after start", func() bool { _, ok := source.reply("p9"); return ok })
		for _, id := range []string{"p6", "p7", "p8"} {
			if _, ok := source.reply(id); ok {
				t.Fatalf("%s was answered", id)
			}
		}
	})

	t.Run("a post is answered once", func(t *testing.T) {
		source.mu.Lock()
		delete(source.replies, "p1")
		source.mu.Unlock()
		source.posts <- post("p1", "alice", "@agent what is the answer?")
		source.posts <- post("p10", "alice", "@agent marker")
		waitFor(t, "the marker reply", func() bool { _, ok := source.reply("p10"); return ok })
		if _, ok := source.reply("p1"); ok {
			t.Fatal("a delivered-again post was answered twice")
		}
	})
}

func TestRuntimeLimits(t *testing.T) {
	t.Run("the daily post limit holds back answers", func(t *testing.T) {
		source, _ := start(t, "0123456789abcdefghij", Options{MaxReplyPosts: 3, MaxPostsPerDay: 3})
		source.posts <- post("p1", "alice", "@agent first")
		waitFor(t, "first reply", func() bool { _, ok := source.reply("p1"); return ok })
		source.posts <- post("p2", "alice", "@agent second")
		time.Sleep(500 * time.Millisecond)
		if _, ok := source.reply("p2"); ok {
			t.Fatal("an answer past the daily limit was posted")
		}
	})

	t.Run("an allowlist answers only its users", func(t *testing.T) {
		source, _ := start(t, "ok", Options{AllowedUserIDs: []string{"alice"}, BlockedUserIDs: []string{"mallory"}})
		source.posts <- post("p1", "bob", "@agent hi")
		source.posts <- post("p2", "alice", "@agent hi")
		waitFor(t, "alice's reply", func() bool { _, ok := source.reply("p2"); return ok })
		if _, ok := source.reply("p1"); ok {
			t.Fatal("a user outside the allowlist was answered")
		}
	})
}

func TestGateOptOutWords(t *testing.T) {
	for text, want := range map[string]string{
		"@agent stop":        "stop",
		"@a @b  Stop!":       "stop",
		"@agent start.":      "start",
		"@agent please stop": "",
		"@agent stop it now": "",
	} {
		if got := optOutCommand(text); got != want {
			t.Errorf("optOutCommand(%q) = %q, want %q", text, got, want)
		}
	}
}
