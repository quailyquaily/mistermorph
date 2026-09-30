package discord

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type fakeGateway struct {
	events []discordapi.Event
}

func (g *fakeGateway) Run(ctx context.Context, handler discordapi.EventHandler) error {
	for _, event := range g.events {
		handler(ctx, event)
	}
	<-ctx.Done()
	return ctx.Err()
}

func gatewayEvent(t *testing.T, eventType string, data any) discordapi.Event {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return discordapi.Event{Type: eventType, Data: raw}
}

type stubLLM struct{}

func (stubLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{Text: `{"type":"final","output":"hello back"}`}, nil
}

type mapReader map[string]string

func (m mapReader) GetString(key string) string { return m[key] }

// TestRuntimeLoop runs the whole runtime against a fake Discord: a DM gets an answer, an
// unaddressed server message does not, a typed server command needs the mention, and a slash
// command's placeholder is replaced by its answer.
func TestRuntimeLoop(t *testing.T) {
	stateDir, cacheDir := t.TempDir(), t.TempDir()
	paths := runtimepaths.FromReader(mapReader{"file_state_dir": stateDir, "file_cache_dir": cacheDir})
	deps := Dependencies{CommonDependencies: depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return testLogger, nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return llmutil.ResolvedRoute{}, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return stubLLM{}, nil },
		Registry:        func() *tools.Registry { return tools.NewRegistry() },
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
		RuntimePaths: paths,
	}}
	store, err := daemonruntime.NewTaskViewForTarget("discord", 10, daemonruntime.TaskViewConfig{TasksDir: paths.TasksDir, JournalDir: paths.JournalDir})
	if err != nil {
		t.Fatal(err)
	}
	api := &fakeDiscordAPI{}
	now := time.Now().UTC()
	author := discordapi.User{ID: "5", Username: "ann"}
	gateway := &fakeGateway{events: []discordapi.Event{
		gatewayEvent(t, discordapi.EventReady, map[string]any{"user": map[string]any{"id": "42"}, "session_id": "s", "application": map[string]any{"id": "42"}}),
		gatewayEvent(t, discordapi.EventGuildCreate, discordapi.Guild{ID: "100", Name: "Lab", Channels: []discordapi.Channel{{ID: "200", Name: "general"}}}),
		gatewayEvent(t, discordapi.EventMessageCreate, discordapi.Message{ID: "301", ChannelID: "300", Content: "hi there", Timestamp: now, Author: author}),
		gatewayEvent(t, discordapi.EventMessageCreate, discordapi.Message{ID: "401", ChannelID: "200", GuildID: "100", Content: "just chatting", Timestamp: now, Author: author}),
		gatewayEvent(t, discordapi.EventMessageCreate, discordapi.Message{ID: "402", ChannelID: "200", GuildID: "100", Content: "/id", Timestamp: now, Author: author}),
		gatewayEvent(t, discordapi.EventMessageCreate, discordapi.Message{ID: "403", ChannelID: "200", GuildID: "100", Content: "<@42> /id", Timestamp: now, Author: author, Mentions: []discordapi.User{{ID: "42"}}}),
		gatewayEvent(t, discordapi.EventInteractionCreate, discordapi.Interaction{
			ID: "500", Token: "tok", Type: discordapi.InteractionTypeApplicationCommand, GuildID: "100", ChannelID: "200",
			Member: &discordapi.InteractionMember{User: author}, Data: discordapi.InteractionData{Name: "id"},
		}),
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, deps, RunOptions{BotToken: "token", TaskStore: store, api: api, gateway: gateway})
	}()

	waitFor := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			api.mu.Lock()
			done := ok()
			api.mu.Unlock()
			if done {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s; created=%+v edits=%v", what, api.created, api.responseEdits)
	}
	sentTo := func(channelID, text string) bool {
		for _, created := range api.created {
			if created.ChannelID == channelID && strings.Contains(created.Message.Content, text) {
				return true
			}
		}
		return false
	}
	waitFor("the DM answer", func() bool { return sentTo("300", "hello back") })
	waitFor("the typed /id answer", func() bool { return sentTo("200", "chat_id=discord:200") })
	waitFor("the slash /id answer", func() bool {
		return len(api.responseEdits) == 1 && strings.Contains(api.responseEdits[0], "chat_id=discord:200")
	})
	waitFor("the slash commands", func() bool { return len(api.commands) > 0 })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() = %v", err)
	}

	api.mu.Lock()
	defer api.mu.Unlock()
	idReplies := 0
	for _, created := range api.created {
		if created.ChannelID == "200" {
			if strings.Contains(created.Message.Content, "hello back") {
				t.Fatalf("an unaddressed server message got an answer: %+v", created)
			}
			if strings.Contains(created.Message.Content, "chat_id=") {
				idReplies++
				if created.Message.MessageReference == nil || created.Message.MessageReference.MessageID != "403" {
					t.Fatalf("the /id reply does not refer to its message: %+v", created.Message.MessageReference)
				}
			}
		}
	}
	if idReplies != 1 {
		t.Fatalf("typed /id answered %d times, want once (only with the mention)", idReplies)
	}
	if len(api.responses) != 1 || api.responses[0].Type != discordapi.InteractionResponseDeferredChannelMessage {
		t.Fatalf("interaction responses = %+v", api.responses)
	}
}
