package topiccontext

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

// fakeCount counts one token per byte of text and tool definition, plus 10 per message.
func fakeCount(calls *int) CountFunc {
	return func(_ context.Context, req llm.Request) (int, error) {
		*calls++
		n := 0
		for _, message := range req.Messages {
			n += 10 + len(messageText(message))
			for _, call := range message.ToolCalls {
				n += len(call.Name) + len(call.RawArguments)
			}
		}
		for _, tool := range req.Tools {
			n += len(tool.Name) + len(tool.Description) + len(tool.ParametersJSON)
		}
		return n, nil
	}
}

func observedStore(t *testing.T, inputTokens int64) (*Store, context.Context) {
	t.Helper()
	store := NewStore(filepath.Join(t.TempDir(), "topic_context.json"))
	request, layout := testRequest()
	ctx := llm.WithRequestLayout(WithScope(context.Background(), Scope{ConversationKey: "console:t1", TopicID: "t1"}), layout)
	store.ObserveRequest(ctx, request, UsageSample{Scene: "console.loop", InputTokens: inputTokens, Model: "claude-x"})
	return store, ctx
}

func TestCountSnapshotUsesTheProvidersCounts(t *testing.T) {
	store, ctx := observedStore(t, 6000)
	calls := 0
	snapshot, err := store.CountSnapshot(ctx, "console:t1", fakeCount(&calls))
	if err != nil {
		t.Fatal(err)
	}
	// System without skills, system, tools, history, current, steps.
	if calls != 6 || snapshot.Method != MethodProvider || snapshot.CountedInputTokens <= 0 {
		t.Fatalf("calls %d, snapshot %+v", calls, snapshot.Method)
	}
	request, _ := testRequest()
	byKind := map[string]int64{}
	var sum int64
	for _, part := range snapshot.Parts {
		byKind[part.Kind] = part.Tokens
		sum += part.Tokens
	}
	if sum != 6000 {
		t.Fatalf("parts add up to %d, want the billed 6000", sum)
	}
	// The tool definition's share matches its counted size.
	toolBytes := len(request.Tools[0].Name) + len(request.Tools[0].Description) + len(request.Tools[0].ParametersJSON)
	want := float64(toolBytes) * 6000 / float64(snapshot.CountedInputTokens)
	if diff := float64(byKind[PartTools]) - want; diff > 1 || diff < -1 {
		t.Fatalf("tools = %d, want about %.1f", byKind[PartTools], want)
	}
	// Counted once: a second look does not ask again.
	if _, err := store.CountSnapshot(ctx, "console:t1", fakeCount(&calls)); err != nil || calls != 6 {
		t.Fatalf("recount: calls %d, %v", calls, err)
	}
	reloaded, _, _ := store.Snapshot("console:t1")
	if reloaded.Method != MethodProvider || reloaded.CountedAt == "" {
		t.Fatalf("counts not saved: %+v", reloaded.Method)
	}
}

func TestCountSnapshotRemembersAProviderThatCannotCount(t *testing.T) {
	store, ctx := observedStore(t, 900)
	calls := 0
	unsupported := func(context.Context, llm.Request) (int, error) {
		calls++
		return 0, llm.ErrTokenCountUnsupported
	}
	if _, err := store.CountSnapshot(ctx, "console:t1", unsupported); !errors.Is(err, llm.ErrTokenCountUnsupported) {
		t.Fatalf("err = %v", err)
	}
	snapshot, err := store.CountSnapshot(ctx, "console:t1", unsupported)
	if err != nil || calls != 1 || !snapshot.CountUnsupported || snapshot.Method != MethodEstimate {
		t.Fatalf("second try: calls %d, %+v, %v", calls, snapshot.CountUnsupported, err)
	}
}

func TestCountSnapshotNeedsTheStoredRequest(t *testing.T) {
	store, ctx := observedStore(t, 900)
	path := store.snapshotPath("console:t1")
	if err := os.Remove(requestPath(path)); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if _, err := store.CountSnapshot(ctx, "console:t1", fakeCount(&calls)); !errors.Is(err, ErrNoStoredRequest) || calls != 0 {
		t.Fatalf("err = %v, calls %d", err, calls)
	}
}
