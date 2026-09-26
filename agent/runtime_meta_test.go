package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestCompactionPreservesMetaAcrossRepeatedCompactions(t *testing.T) {
	metaIndex := 2
	meta := llm.Message{Role: "user", Content: `{"mister_morph_meta":{"run_id":"owned"}}`}
	client := &contextCompactionTestClient{handler: func(_ int, req llm.Request) (llm.Result, error) {
		if strings.Contains(req.Messages[1].Content, "owned") {
			t.Fatal("runtime metadata entered checkpoint request")
		}
		return contextCompactionResult(), nil
	}}
	e := newContextCompactionEngine(client, contextCompactionTestConfig())
	st := &engineLoopState{
		messages: []llm.Message{{Role: "system", Content: "system"}, {Role: "user", Content: "old"}, meta,
			{Role: "user", Content: "task"}, {Role: "assistant", Content: "recent"}},
		metaMessageIndex: &metaIndex, fixedMessageCount: 1,
		messageBoundaries:       map[int]string{1: "old", 3: "task", 4: "recent"},
		protectedMessageIndexes: map[int]struct{}{4: {}},
		checkpointStore:         newRunLocalCheckpointStore(), agentCtx: NewContext("task", 5),
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for i := 0; i < 2; i++ {
		if err := e.compactContext(context.Background(), st, i, contextCompactionDecision{CompactFullPrefix: true, OutputReserve: 4096}); err != nil {
			t.Fatal(err)
		}
		if len(st.messages) != 4 || st.metaMessageIndex == nil || *st.metaMessageIndex != 2 || st.messages[2].Content != meta.Content {
			t.Fatalf("messages/meta = %#v / %v", st.messages, st.metaMessageIndex)
		}
		if st.messageBoundaries[3] != "recent" || !messageIndexProtected(3, st.protectedMessageIndexes) {
			t.Fatalf("tail indexes lost: %#v / %#v", st.messageBoundaries, st.protectedMessageIndexes)
		}
	}
}

func TestMetaIsNotCompactionReleaseOrStandaloneSummary(t *testing.T) {
	index := 1
	messages := []llm.Message{{Role: "system", Content: "system"}, {Role: "user", Content: strings.Repeat("meta", 100)}, {Role: "user", Content: "current"}}
	blocks := buildTranscriptBlocks(messages, transcriptBlockOptions{FixedMessageCount: 1, MetaMessageIndex: &index})
	if blocks[0].EstimatedTokens != 0 {
		t.Fatal("retained meta counted as released tokens")
	}
	if _, ok := selectTranscriptPrefix(blocks, 1); ok {
		t.Fatal("meta alone is not a valid summary")
	}
}

func TestResumeStateMetaVersionAndValidation(t *testing.T) {
	index := 2
	st := resumeState{FixedMessageCount: 1, MetaMessageIndex: &index, Messages: []llm.Message{
		{Role: "system", Content: "system"}, {Role: "user", Content: "history"}, {Role: "user", Content: "meta"},
	}}
	raw, err := marshalResumeState(st)
	if err != nil {
		t.Fatal(err)
	}
	got, err := unmarshalResumeState(raw)
	if err != nil || got.Version != 2 || got.MetaMessageIndex == nil || *got.MetaMessageIndex != index {
		t.Fatalf("restore = %#v, %v", got, err)
	}
	st.MetaMessageIndex = new(int)
	// A malformed new snapshot must fail before an approval is consumed.
	st.Version = 2
	raw, _ = json.Marshal(st)
	if _, err := unmarshalResumeState(raw); err == nil {
		t.Fatal("accepted invalid meta index")
	}
	if _, err := unmarshalResumeState([]byte(`{"v":1,"fixed_message_count":2,"messages":[{"role":"system","content":"system"},{"role":"user","content":"meta"}]}`)); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryCacheBreakpointIsRequestOnly(t *testing.T) {
	for _, role := range []string{"user", "assistant"} {
		t.Run(role, func(t *testing.T) {
			index := 2
			history := llm.Message{Role: role, Content: "history", Parts: []llm.Part{
				{Type: llm.PartTypeText, Text: "history"}, {Type: llm.PartTypeImageURL, URL: "https://example.test/image.png"},
			}}
			st := &engineLoopState{metaMessageIndex: &index, messages: []llm.Message{
				{Role: "system", Content: "system"}, history, {Role: "user", Content: "meta"}, {Role: "user", Content: "current"},
			}}
			e := newContextCompactionEngine(newMockClient(), contextCompactionTestConfig())
			e.systemPromptCacheControl = &llm.CacheControl{TTL: "short"}
			req := e.mainRequest(st, nil)
			if req.Messages[1].Parts[0].CacheControl == nil || req.Messages[1].Parts[0].CacheControl.TTL != "short" {
				t.Fatal("history breakpoint missing")
			}
			if !reflect.DeepEqual(st.messages[1], history) || history.Parts[0].CacheControl != nil {
				t.Fatal("mutated source history")
			}
			if len(req.Messages[1].Parts) != 2 || req.Messages[1].Parts[1].URL != history.Parts[1].URL {
				t.Fatal("image lost")
			}
			for _, m := range req.Messages[2:] {
				for _, p := range m.Parts {
					if p.CacheControl != nil {
						t.Fatal("dynamic message marked")
					}
				}
			}
			e.systemPromptCacheControl = nil
			if !reflect.DeepEqual(e.mainRequest(st, nil).Messages, st.messages) {
				t.Fatal("caching disabled but messages changed")
			}
		})
	}
}

func TestHookCannotReplaceRuntimeMetadata(t *testing.T) {
	client := newMockClient(finalResponse("done"))
	e := New(client, tools.NewRegistry(), baseCfg(), DefaultPromptSpec(), WithHook(func(_ context.Context, _ int, _ *Context, messages *[]llm.Message) error {
		*messages = (*messages)[:1]
		return nil
	}))
	if _, _, err := e.Run(context.Background(), "task", RunOptions{}); err == nil {
		t.Fatal("accepted hook removing runtime metadata")
	}
	if len(client.allCalls()) != 0 {
		t.Fatal("sent corrupted context to model")
	}
}

func TestApprovalResumeKeepsNewAndLegacyMetaLayouts(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "legacy"}[legacy], func(t *testing.T) {
			store := newMemoryApprovalStore()
			g := approvalGuard(store, nil)
			calls := 0
			reg := tools.NewRegistry()
			reg.Register(&countingTool{name: "bash", result: "done", count: &calls})
			client := newMockClient(toolCallResponse("bash"), finalResponse("done"))
			e := New(client, reg, baseCfg(), DefaultPromptSpec(), WithGuard(g))
			pending, _, err := e.Run(context.Background(), "task", RunOptions{History: []llm.Message{{Role: "user", Content: "history"}}})
			if err != nil {
				t.Fatal(err)
			}
			id := pendingApprovalID(t, pending)
			rec, _, _ := store.Get(context.Background(), id)
			rs, err := unmarshalResumeState(rec.ResumeState)
			if err != nil {
				t.Fatal(err)
			}
			if rs.Version != 2 || rs.MetaMessageIndex == nil || *rs.MetaMessageIndex != 2 {
				t.Fatalf("new snapshot = %#v", rs)
			}
			meta := rs.Messages[2].Content
			if legacy {
				rs.Messages[1], rs.Messages[2] = rs.Messages[2], rs.Messages[1]
				rs.Version, rs.FixedMessageCount, rs.MetaMessageIndex = 1, 2, nil
				rec.ResumeState, _ = json.Marshal(rs)
				store.records[id] = rec
			}
			if err := store.Resolve(context.Background(), id, guard.ApprovalApproved, "test", ""); err != nil {
				t.Fatal(err)
			}
			if _, _, err := e.Resume(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			requests := client.allCalls()
			wantIndex := 2
			if legacy {
				wantIndex = 1
			}
			if len(requests) != 2 || requests[1].Messages[wantIndex].Content != meta || calls != 1 {
				t.Fatalf("resume changed layout or repeated tool: calls=%d requests=%#v", calls, requests)
			}
		})
	}
}
