package topiccontext

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

const testSystemPrompt = `## Persona
You are Morph.

## Available Skills
- name: ` + "`pdf`" + `
  description: Reads PDFs.

## Additional Policies

[[ WeChat Policies ]]
- Plain text only.

[[ Workspace ]]
- The workspace is /tmp/w.

## Response Format
` + "```json" + `
## not a heading inside a fence
` + "```"

func testRequest() (llm.Request, llm.RequestLayout) {
	request := llm.Request{
		Messages: []llm.Message{
			{Role: "system", Content: testSystemPrompt},
			{Role: "user", Content: "summary of earlier turns"},
			{Role: "user", Content: "earlier question"},
			{Role: "assistant", Content: "earlier answer"},
			{Role: "user", Content: `{"mister_morph_meta":{}}`},
			{Role: "user", Content: "read the report"},
			{Role: "assistant", ToolCalls: []llm.ToolCall{{ID: "c1", Name: "read_file", RawArguments: `{"path":"r.pdf"}`}}},
			{Role: "tool", ToolCallID: "c1", Content: strings.Repeat("report text ", 200)},
		},
		Tools: []llm.Tool{{Name: "read_file", Description: "Reads a file.", ParametersJSON: `{"type":"object"}`}},
	}
	layout := llm.RequestLayout{MessageKinds: []string{
		llm.MessageKindSystem, llm.MessageKindSummary, llm.MessageKindHistory, llm.MessageKindHistory,
		llm.MessageKindMeta, llm.MessageKindCurrent, llm.MessageKindStep, llm.MessageKindStep,
	}}
	return request, layout
}

func TestBuildSnapshotSplitsTheRequestAndMatchesTheReportedTotal(t *testing.T) {
	request, layout := testRequest()
	snapshot := BuildSnapshot(request, layout, UsageSample{InputTokens: 5000, Model: "gpt-x", UpdatedAt: time.Unix(100, 0)})
	var kinds []string
	var sum int64
	byKind := map[string]Part{}
	for _, part := range snapshot.Parts {
		kinds = append(kinds, part.Kind)
		sum += part.Tokens
		byKind[part.Kind] = part
		var childSum int64
		for _, child := range part.Children {
			childSum += child.Tokens
		}
		if childSum != part.Tokens {
			t.Fatalf("%s: children add up to %d, part has %d", part.Kind, childSum, part.Tokens)
		}
	}
	if strings.Join(kinds, ",") != "system,skills,tools,history,current,steps" || sum != 5000 {
		t.Fatalf("parts = %v, sum %d", kinds, sum)
	}
	var sections []string
	for _, child := range byKind[PartSystem].Children {
		sections = append(sections, child.Label)
	}
	if strings.Join(sections, "|") != "Persona|WeChat Policies|Workspace|Response Format" {
		t.Fatalf("system sections = %q", sections)
	}
	if !strings.HasPrefix(byKind[PartSystem].Children[1].Content, "## Additional Policies") {
		t.Fatalf("policies heading lost: %q", byKind[PartSystem].Children[1].Content)
	}
	if len(byKind[PartSkills].Children) != 1 || !strings.Contains(byKind[PartSkills].Children[0].Content, "Reads PDFs") {
		t.Fatalf("skills = %+v", byKind[PartSkills])
	}
	history := byKind[PartHistory].Children
	if len(history) != 3 || history[0].Kind != PartSummary {
		t.Fatalf("history = %+v", history)
	}
	steps := byKind[PartSteps].Children
	if len(steps) != 2 || steps[0].Tool != "read_file" || steps[1].Role != "tool" || steps[1].Tool != "read_file" {
		t.Fatalf("steps = %+v", steps)
	}
	// The long tool result outweighs the short history.
	if byKind[PartSteps].Tokens <= byKind[PartHistory].Tokens {
		t.Fatalf("steps %d tokens, history %d", byKind[PartSteps].Tokens, byKind[PartHistory].Tokens)
	}
	if snapshot.Method != MethodEstimate || snapshot.CapturedAt != "1970-01-01T00:01:40Z" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestEstimateTokensCountsOtherScriptsPerCharacter(t *testing.T) {
	if got := EstimateTokens(strings.Repeat("a", 36)); got != 10 {
		t.Fatalf("ascii estimate = %v", got)
	}
	if got := EstimateTokens("上下文窗口"); got != 5 {
		t.Fatalf("cjk estimate = %v", got)
	}
}

func TestObserveRequestKeepsTheLatestSnapshotPerConversation(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "topic_context.json"))
	request, layout := testRequest()
	ctx := llm.WithRequestLayout(WithScope(context.Background(), Scope{ConversationKey: "console:t1", TopicID: "t1"}), layout)
	store.ObserveRequest(ctx, request, UsageSample{Scene: "console.loop", InputTokens: 900})
	store.ObserveRequest(ctx, request, UsageSample{Scene: "console.loop", InputTokens: 1200})
	store.ObserveRequest(ctx, request, UsageSample{Scene: "console.title", InputTokens: 7})
	snapshot, ok, err := store.Snapshot("console:t1")
	if err != nil || !ok || snapshot.InputTokens != 1200 || snapshot.TopicID != "t1" {
		t.Fatalf("Snapshot = %+v, %v, %v", snapshot.InputTokens, ok, err)
	}
	if err := store.DeleteSnapshot("console:t1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := store.Snapshot("console:t1"); ok {
		t.Fatal("snapshot left after DeleteSnapshot")
	}
	if err := store.DeleteSnapshot("console:t1"); err != nil {
		t.Fatalf("deleting a missing snapshot: %v", err)
	}
	if _, ok, _ := store.Snapshot("console:other"); ok {
		t.Fatal("snapshot for an unseen conversation")
	}
}

func TestSnapshotsLiveInTheTopicFolder(t *testing.T) {
	root := t.TempDir()
	store := NewStore(filepath.Join(root, "topic_context.json"))
	request, layout := testRequest()
	ctx := llm.WithRequestLayout(WithScope(context.Background(), Scope{ConversationKey: "console:t1", TopicID: "t1"}), layout)
	store.ObserveRequest(ctx, request, UsageSample{Scene: "console.loop", InputTokens: 900})
	dir := store.TopicDir("console:t1")
	if filepath.Dir(dir) != filepath.Join(root, "topics") {
		t.Fatalf("topic folder = %s", dir)
	}
	for _, name := range []string{"context_snapshot.json", "context_request.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if err := store.DeleteSnapshot("console:t1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("topic folder left after delete: %v", err)
	}
}

func TestBuildSnapshotMarksCacheTags(t *testing.T) {
	ttl := &llm.CacheControl{TTL: "1h"}
	request := llm.Request{
		Messages: []llm.Message{
			{Role: "system", Parts: []llm.Part{{Type: llm.PartTypeText, Text: "Intro\n\n## Available Skills\n- a\n\n## Rules\nBe kind.", CacheControl: ttl}}},
			{Role: "user", Content: "earlier"},
			{Role: "assistant", Parts: []llm.Part{{Type: llm.PartTypeText, Text: "reply", CacheControl: &llm.CacheControl{}}}},
			{Role: "user", Content: "now"},
		},
		Tools: []llm.Tool{{Name: "a"}, {Name: "b", CacheControl: ttl}},
	}
	layout := llm.RequestLayout{MessageKinds: []string{llm.MessageKindSystem, llm.MessageKindHistory, llm.MessageKindHistory, llm.MessageKindCurrent}}
	snapshot := BuildSnapshot(request, layout, UsageSample{InputTokens: 100})
	marked := map[string]string{}
	for _, part := range snapshot.Parts {
		for i, child := range part.Children {
			if child.CacheBreakpoint {
				marked[fmt.Sprintf("%s:%d", part.Kind, i)] = child.CacheTTL
			}
		}
	}
	// The prompt's tag goes on its last section ("Rules"), not on the skills.
	want := map[string]string{"system:1": "1h", "history:1": "", "tools:1": "1h"}
	if !reflect.DeepEqual(marked, want) {
		t.Fatalf("cache marks = %v, want %v", marked, want)
	}
}
