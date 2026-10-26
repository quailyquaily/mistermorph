package chatcmd

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate"
	"github.com/quailyquaily/mistermorph/internal/llmselect"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func promptKeys(text string) []tea.Msg {
	msgs := make([]tea.Msg, 0, len(text))
	for _, r := range text {
		msgs = append(msgs, tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	return msgs
}

func promptKey(code rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: code} }

func promptTestModel() *chatModel {
	m := newChatModel(nil)
	m.width, m.height = 80, 24
	return m
}

func viewText(m *chatModel) string { return ansi.Strip(m.View().Content) }

// assertSecretNowhere checks every place the password must never reach.
func assertSecretNowhere(t *testing.T, m *chatModel, secret string) {
	t.Helper()
	if strings.Contains(viewText(m), secret) {
		t.Fatalf("view shows the password:\n%s", viewText(m))
	}
	for _, block := range m.transcriptQueue {
		if strings.Contains(block, secret) {
			t.Fatalf("transcript has the password: %q", block)
		}
	}
	for _, line := range m.inputHistory {
		if strings.Contains(line, secret) {
			t.Fatalf("input history has the password: %q", line)
		}
	}
	if strings.Contains(m.textarea.Value(), secret) {
		t.Fatal("composer has the password")
	}
}

func TestLocalElevationApprover(t *testing.T) {
	const secret = "hunter2-ü"
	tests := []struct {
		name         string
		attempt      int
		keys         []tea.Msg
		expire       bool
		wantPassword string
		wantErr      error
		wantOutcome  string
		wantView     string
	}{
		{
			name:         "allow",
			keys:         append(promptKeys(secret), promptKey(tea.KeyEnter)),
			wantPassword: secret,
			wantOutcome:  "password sent",
		},
		{
			name:         "retry after a wrong password, with an edit and a paste",
			attempt:      2,
			keys:         append(append(promptKeys("hunter2x"), promptKey(tea.KeyBackspace), tea.PasteMsg{Content: "-ü\n"}), promptKey(tea.KeyEnter)),
			wantPassword: secret,
			wantOutcome:  "password sent",
			wantView:     "The password was not accepted. Try again.",
		},
		{
			name:        "decline",
			keys:        append(promptKeys(secret), promptKey(tea.KeyEscape)),
			wantErr:     elevate.ErrDeclined,
			wantOutcome: "declined",
		},
		{
			name:        "empty enter does not allow, then expiry",
			keys:        append(promptKeys(secret), tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl}, promptKey(tea.KeyEnter)),
			expire:      true,
			wantErr:     elevate.ErrTimedOut,
			wantOutcome: "no answer in time",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			msgs := make(chan any, 8)
			prompter := newLocalPrompter(func(msg any) { msgs <- msg })
			m := promptTestModel()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type result struct {
				password string
				err      error
			}
			done := make(chan result, 1)
			go func() {
				password, err := prompter.approve(ctx, elevate.Request{
					Command:  "apt-get install -y ripgrep && systemctl restart nginx.service --no-block",
					Dir:      "/srv/app",
					Deadline: time.Now().Add(2 * time.Minute),
					Attempt:  tc.attempt,
				})
				done <- result{password, err}
			}()
			m.Update(<-msgs)
			view := viewText(m)
			for _, want := range []string{"Administrator rights needed", "apt-get install -y ripgrep", "/srv/app", "Password", "Enter allow", "Esc decline", "left", tc.wantView} {
				if !strings.Contains(view, want) {
					t.Fatalf("modal missing %q:\n%s", want, view)
				}
			}
			for _, key := range tc.keys {
				m.Update(key)
				assertSecretNowhere(t, m, secret)
			}
			if tc.expire {
				if m.activePrompt() == nil || !strings.Contains(viewText(m), "Type the password") {
					t.Fatalf("empty Enter closed the modal:\n%s", viewText(m))
				}
				cancel()
				m.Update(<-msgs)
			}
			got := <-done
			if got.password != tc.wantPassword || !errors.Is(got.err, tc.wantErr) || (tc.wantErr == nil && got.err != nil) {
				t.Fatalf("approve() = %q, %v; want %q, %v", got.password, got.err, tc.wantPassword, tc.wantErr)
			}
			if m.activePrompt() != nil {
				t.Fatal("modal still open")
			}
			transcript := ansi.Strip(strings.Join(m.transcriptQueue, "\n"))
			if !strings.Contains(transcript, tc.wantOutcome) || !strings.Contains(transcript, "apt-get install") {
				t.Fatalf("transcript = %q, want outcome %q", transcript, tc.wantOutcome)
			}
			assertSecretNowhere(t, m, secret)
			assertSecretNowhere(t, m, "hunter2")
			if !strings.Contains(viewText(m), "❯") {
				t.Fatalf("composer did not come back:\n%s", viewText(m))
			}
		})
	}
}

func TestLocalQuestionPrompt(t *testing.T) {
	question := taskruntime.UserQuestion{ID: "q1", Text: "Which database should I use?", Options: []taskruntime.UserQuestionOption{
		{Label: "Postgres", Description: "the usual choice"},
		{Label: "SQLite"},
	}}
	tests := []struct {
		name        string
		keys        []tea.Msg
		expire      bool
		want        runtimecontrol.Answer
		wantErr     error
		wantOutcome string
	}{
		{name: "choose by number", keys: promptKeys("2"), want: runtimecontrol.Answer{Text: "SQLite", Option: 1}, wantOutcome: "Answer: SQLite"},
		{name: "number out of range types", keys: append(promptKeys("9 lives"), promptKey(tea.KeyEnter)), want: runtimecontrol.Answer{Text: "9 lives", Option: -1}, wantOutcome: "Answer: 9 lives"},
		{name: "typed answer", keys: append(promptKeys("MySQL, please"), promptKey(tea.KeyEnter)), want: runtimecontrol.Answer{Text: "MySQL, please", Option: -1}, wantOutcome: "Answer: MySQL, please"},
		{name: "esc clears, then dismisses", keys: append(promptKeys("x"), promptKey(tea.KeyEscape), promptKey(tea.KeyEscape)), wantErr: errQuestionDismissed, wantOutcome: "dismissed"},
		{name: "expiry", expire: true, wantErr: context.DeadlineExceeded, wantOutcome: "no answer in time"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			msgs := make(chan any, 8)
			prompter := newLocalPrompter(func(msg any) { msgs <- msg })
			m := promptTestModel()
			m.textarea.SetValue("unsent draft")
			wait := time.Minute
			if tc.expire {
				wait = 50 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), wait)
			defer cancel()
			type result struct {
				answer runtimecontrol.Answer
				err    error
			}
			done := make(chan result, 1)
			go func() {
				answer, err := prompter.ask(ctx, question)
				done <- result{answer, err}
			}()
			m.Update(<-msgs)
			view := viewText(m)
			for _, want := range []string{"? Question", "Which database should I use?", "1. Postgres — the usual choice", "2. SQLite", "1–2 choose", "Esc dismiss"} {
				if !strings.Contains(view, want) {
					t.Fatalf("card missing %q:\n%s", want, view)
				}
			}
			for _, key := range tc.keys {
				m.Update(key)
			}
			if tc.expire {
				m.Update(<-msgs)
			}
			got := <-done
			if got.answer != tc.want || !errors.Is(got.err, tc.wantErr) || (tc.wantErr == nil && got.err != nil) {
				t.Fatalf("ask() = %+v, %v; want %+v, %v", got.answer, got.err, tc.want, tc.wantErr)
			}
			if m.activePrompt() != nil {
				t.Fatal("card still open")
			}
			if transcript := ansi.Strip(strings.Join(m.transcriptQueue, "\n")); !strings.Contains(transcript, tc.wantOutcome) {
				t.Fatalf("transcript = %q, want %q", transcript, tc.wantOutcome)
			}
			if m.textarea.Value() != "unsent draft" || len(m.inputHistory) != 0 {
				t.Fatalf("card touched the composer: %q, history %v", m.textarea.Value(), m.inputHistory)
			}
		})
	}
}

func TestLocalPromptsQueueOneAtATime(t *testing.T) {
	m := promptTestModel()
	first := newQuestionPrompt("a", taskruntime.UserQuestion{Text: "First?"}, time.Time{})
	second := newQuestionPrompt("b", taskruntime.UserQuestion{Text: "Second?"}, time.Time{})
	for _, p := range []*chatPrompt{first, second} {
		p.respond = func(m *chatModel, p *chatPrompt, _ chatPromptResponse) tea.Cmd { return m.closePrompt(p.key, "") }
		m.Update(promptOpenMsg{prompt: p})
	}
	m.Update(promptOpenMsg{prompt: first})
	if len(m.prompts) != 2 || !strings.Contains(viewText(m), "First?") || !strings.Contains(viewText(m), "1 more waiting") {
		t.Fatalf("queue = %d:\n%s", len(m.prompts), viewText(m))
	}
	m.Update(promptKey(tea.KeyEscape))
	if !strings.Contains(viewText(m), "Second?") {
		t.Fatalf("next card not shown:\n%s", viewText(m))
	}
	m.Update(promptOpenMsg{prompt: first})
	if len(m.prompts) != 1 {
		t.Fatal("a closed card opened again")
	}
}

func TestWithLocalPromptsSetsApproverAndQuestions(t *testing.T) {
	ctx := withLocalPrompts(context.Background(), newLocalPrompter(func(any) {}))
	if _, ok := elevate.ApproverFromContext(ctx); !ok {
		t.Fatal("no approver on the turn's context")
	}
	if ctx := withLocalPrompts(context.Background(), newLocalPrompter(nil)); ctx != context.Background() {
		t.Fatal("a prompter without a program changed the context")
	}
}

// askUserScriptClient asks a question through ask_user, then finishes with the answer it got.
type askUserScriptClient struct {
	mu    sync.Mutex
	calls int
	tools []string
	seen  string
}

func (c *askUserScriptClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.calls == 1 {
		for _, tool := range req.Tools {
			c.tools = append(c.tools, tool.Name)
		}
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "call_1", Name: taskruntime.AskUserToolName, Arguments: map[string]any{
			"question": "Deploy to staging or production?",
			"options":  []any{map[string]any{"label": "staging"}, map[string]any{"label": "production"}},
		}}}}, nil
	}
	for _, message := range req.Messages {
		if strings.Contains(message.Content, "The user chose") {
			c.seen = message.Content
		}
	}
	return llm.Result{Text: "Deploying to staging."}, nil
}

func (c *askUserScriptClient) Close() error { return nil }

func TestLocalTurnOffersAskUserAndShowsTheCard(t *testing.T) {
	values := llmutil.RuntimeValues{Provider: "openai", Model: "main-model"}
	client := &askUserScriptClient{}
	rt, err := taskruntime.NewRunPreparer(depsutil.CommonDependencies{
		Logger:     func() (*slog.Logger, error) { return slog.Default(), nil },
		LogOptions: func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
			return llmutil.ResolveRoute(values, purpose)
		},
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
		Registry:        func() *tools.Registry { return tools.NewRegistry() },
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}, taskruntime.BootstrapOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	sess := &chatSession{cmd: New(Dependencies{}), sessionStore: llmselect.NewStore(), llmValues: values, taskRuntime: rt}

	m := promptTestModel()
	msgs := make(chan any, 8)
	ctx := withLocalPrompts(context.Background(), newLocalPrompter(func(msg any) { msgs <- msg }))
	prepared, err := sess.prepareRuntimeForTaskRoute(ctx, "deploy", llmutil.RoutePurposeMainLoop, "", "chat-turn")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = prepared.Cleanup() }()
	type result struct {
		final *agent.Final
		err   error
	}
	done := make(chan result, 1)
	go func() {
		final, _, err := prepared.Engine.Run(ctx, "deploy", agent.RunOptions{Model: prepared.Model, Scene: "chat.loop"})
		done <- result{final, err}
	}()
	select {
	case msg := <-msgs:
		m.Update(msg)
	case r := <-done:
		t.Fatalf("run ended without asking: %+v %v (tools %v)", r.final, r.err, client.tools)
	case <-time.After(10 * time.Second):
		t.Fatal("no question card")
	}
	if !strings.Contains(viewText(m), "Deploy to staging or production?") {
		t.Fatalf("card:\n%s", viewText(m))
	}
	m.Update(promptKeys("1")[0])
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if !strings.Contains(strings.Join(client.tools, ","), taskruntime.AskUserToolName) {
		t.Fatalf("ask_user not offered: %v", client.tools)
	}
	if !strings.Contains(client.seen, "The user chose: staging") {
		t.Fatalf("the model did not get the answer: %q", client.seen)
	}
}
