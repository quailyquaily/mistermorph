package consolecmd

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

// A suggestion is a draft for the rename dialog: generating it saves nothing, and only the rename
// that follows (with the suggestion or an edit of it) names the topic.
func TestConsoleSuggestTopicTitleSavesNothing(t *testing.T) {
	for _, mode := range []string{"success", "failed", "empty", "reserved", "todo item", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			store, _ := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
			topic, _ := store.CreateTopic("seed")
			if err := store.SetTopicTitleFromLLM(topic.ID, "seed", "First name", "code"); err != nil {
				t.Fatal(err)
			}
			if mode != "empty" {
				if err := store.Upsert(daemonruntime.TaskInfo{ID: "first", TopicID: topic.ID, Task: "Discuss baby sleep", CreatedAt: time.Unix(1, 0), Status: daemonruntime.TaskDone, Result: map[string]any{"output": "Sleep routine"}}); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := store.GetTopic(topic.ID)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			generation := &consoleLocalRuntimeGeneration{commonDeps: depsutil.CommonDependencies{
				ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) {
					return llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Model: "test"}}, nil
				},
				CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) {
					return topicNamingClientFunc(func(context.Context, llm.Request) (llm.Result, error) {
						calls++
						switch mode {
						case "failed":
							return llm.Result{}, errors.New("offline")
						case "cancelled":
							cancel()
						}
						return llm.Result{Text: `{"title":"Baby sleep.","icon":"baby"}`}, nil
					}), nil
				},
			}}
			rt := &consoleLocalRuntime{store: store}
			id := topic.ID
			switch mode {
			case "reserved":
				id = daemonruntime.ConsoleDefaultTopicID
			case "todo item":
				id = daemonruntime.CronTopicID("weekly")
			}
			got, err := rt.suggestTopicTitle(ctx, generation, id)
			if mode == "success" {
				if err != nil || got.Title != "Baby sleep" || got.Icon != "baby" {
					t.Fatalf("suggestion = %+v, error = %v", got, err)
				}
			} else if err == nil {
				t.Fatalf("suggestion = %+v, want an error", got)
			}
			if mode == "empty" || mode == "reserved" || mode == "todo item" {
				if calls != 0 {
					t.Fatalf("calls = %d, error = %v", calls, err)
				}
			}
			after, _ := store.GetTopic(topic.ID)
			if after.Title != before.Title || after.Icon != before.Icon || after.TitleRevision != before.TitleRevision || after.TitleCustomized != before.TitleCustomized || !after.UpdatedAt.Equal(before.UpdatedAt) {
				t.Fatalf("suggestion changed the topic: %+v, before %+v", after, before)
			}
			if refs := consoleGenerationRefs(generation); refs != 0 {
				t.Fatalf("leaked generation refs: %d", refs)
			}
			// Saving the suggestion is the rename, and later naming leaves it alone.
			if mode == "success" {
				saved, err := store.RenameTopic(topic.ID, got.Title+" plan")
				if err != nil || saved.Title != "Baby sleep plan" || saved.Icon != "code" {
					t.Fatalf("saved = %+v, error = %v", saved, err)
				}
				if err := store.SetTopicTitleFromLLM(topic.ID, saved.Title, "Other", "chat"); err != nil {
					t.Fatal(err)
				}
				if after, _ := store.GetTopic(topic.ID); after.Title != "Baby sleep plan" {
					t.Fatalf("automatic naming overwrote the rename: %+v", after)
				}
			}
		})
	}
}
