package core

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/llm"
)

type steerReplyClient func(context.Context, llm.Request) (llm.Result, error)

func (f steerReplyClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	return f(ctx, req)
}

func TestGenerationSteerResponderRepliesToChannelMessages(t *testing.T) {
	var got llm.Request
	var runID string
	generations := NewStaticRuntimeGenerationManager(ChannelRuntimeBundle{TaskRuntime: &taskruntime.Runtime{
		BootstrapMainModel: "main-model",
		BootstrapMainClient: steerReplyClient(func(ctx context.Context, req llm.Request) (llm.Result, error) {
			got, runID = req, llmstats.RunIDFromContext(ctx)
			return llm.Result{Text: "Okay, I'll compare prices in euros instead."}, nil
		}),
	}}, nil)
	defer generations.Close()

	control := runtimecontrol.New()
	lease, err := control.StartLease(context.Background(), 0, runtimecontrol.ActiveRun{
		Runtime: "mixin", ConversationKey: "mixin:1", TaskID: "task_1", Task: "Compare flight prices",
		Conversation: SteerConversation([]chathistory.ChatHistoryItem{
			{Kind: chathistory.KindInboundUser, Text: "I fly from Berlin"},
			{Kind: chathistory.KindInboundReaction, Text: "👍"},
			{Kind: chathistory.KindOutboundAgent, Text: "Berlin noted."},
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Finish()
	responder := NewGenerationSteerResponder(context.Background(), generations, nil)
	var replies []runtimecontrol.SteerReply
	if err := responder.Respond(control.Steer("mixin", "mixin:1", "use euros"), func(_ context.Context, reply runtimecontrol.SteerReply) error {
		replies = append(replies, reply)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	responder.Wait()

	if len(replies) != 1 || replies[0].Status != runtimecontrol.SteerReplied || replies[0].Text != "Okay, I'll compare prices in euros instead." {
		t.Fatalf("replies = %+v", replies)
	}
	if got.Model != "main-model" || runID != "task_1" {
		t.Fatalf("request model %q run %q", got.Model, runID)
	}
	prompt := got.Messages[1].Content
	for _, want := range []string{"Compare flight prices", "I fly from Berlin", "Berlin noted.", "use euros"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt misses %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "👍") {
		t.Errorf("prompt includes a reaction:\n%s", prompt)
	}
}

func TestGenerationSteerReplierWithoutGenerationFails(t *testing.T) {
	generations := NewStaticRuntimeGenerationManager(ChannelRuntimeBundle{}, nil)
	generations.Close()
	if _, err := GenerationSteerReplier(generations)(context.Background(), runtimecontrol.SteerReplyRequest{Input: "hi"}); err == nil {
		t.Fatal("replier without a generation returned no error")
	}
	var nilManager *RuntimeGenerationManager
	if _, err := GenerationSteerReplier(nilManager)(context.Background(), runtimecontrol.SteerReplyRequest{Input: "hi"}); err == nil {
		t.Fatal("replier without a manager returned no error")
	}
}
