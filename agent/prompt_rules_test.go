package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/tools"
)

type schemaMarkerTool struct{}

func (t schemaMarkerTool) Name() string        { return "schema_marker" }
func (t schemaMarkerTool) Description() string { return "marker tool description" }
func (t schemaMarkerTool) ParameterSchema() string {
	return "SCHEMA_MARKER"
}
func (t schemaMarkerTool) Execute(_ context.Context, _ map[string]any) (string, error) {
	return "ok", nil
}

type planCreateMarkerTool struct{}

func (t planCreateMarkerTool) Name() string            { return "plan_create" }
func (t planCreateMarkerTool) Description() string     { return "plan tool marker" }
func (t planCreateMarkerTool) ParameterSchema() string { return "{}" }
func (t planCreateMarkerTool) Execute(_ context.Context, _ map[string]any) (string, error) {
	return "ok", nil
}

func TestBuildSystemPrompt_UsesToolSummaries(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(schemaMarkerTool{})

	prompt := BuildSystemPrompt(reg, DefaultPromptSpec())
	if !strings.Contains(prompt, "marker tool description") {
		t.Fatalf("expected tool description to be present in prompt")
	}
	if strings.Contains(prompt, "SCHEMA_MARKER") {
		t.Fatalf("expected tool schema to be omitted from prompt")
	}
}

func TestBuildSystemPrompt_HidesPlanOptionWithoutPlanCreate(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(schemaMarkerTool{})

	prompt := BuildSystemPrompt(reg, DefaultPromptSpec())
	if strings.Contains(prompt, "### Option 1: Plan") {
		t.Fatalf("did not expect plan response format without plan_create tool")
	}
	if !strings.Contains(prompt, "### Final") {
		t.Fatalf("expected final response format section")
	}
}

func TestBuildSystemPrompt_ShowsPlanOptionWithPlanCreate(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(schemaMarkerTool{})
	reg.Register(planCreateMarkerTool{})

	prompt := BuildSystemPrompt(reg, DefaultPromptSpec())
	if !strings.Contains(prompt, "### Option 1: Plan") {
		t.Fatalf("expected plan response format with plan_create tool")
	}
	if !strings.Contains(prompt, "### Option 2: Final") {
		t.Fatalf("expected final response format option label with plan_create tool")
	}
}

func TestPromptRules_NoURL_NoInjection(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, baseRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "summarize this text", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if strings.Contains(prompt, rulePreferURLFetch) {
		t.Fatalf("unexpected URL rule in prompt")
	}
}

func TestPromptRules_SingleURL_Injection(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, baseRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "visit https://example.com then summarize", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if !strings.Contains(prompt, rulePreferURLFetch) {
		t.Fatalf("expected prefer-url_fetch rule in prompt")
	}
	if !strings.Contains(prompt, ruleURLFetchFail) {
		t.Fatalf("expected url_fetch failure rule in prompt")
	}
	if strings.Contains(prompt, ruleBatchURLFetch) {
		t.Fatalf("did not expect batch rule for single URL")
	}
}

func TestPromptRules_MultiURL_BatchRule(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, baseRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "visit https://a.com and https://b.com", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if !strings.Contains(prompt, ruleBatchURLFetch) {
		t.Fatalf("expected batch url_fetch rule for multi-URL task")
	}
}

func TestPromptRules_BinaryURL_DownloadPathRule(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, baseRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "visit https://example.com/report.pdf", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if !strings.Contains(prompt, rulePreferDownload) {
		t.Fatalf("expected download_path rule for binary URL")
	}
	if strings.Contains(prompt, ruleRangeProbe) {
		t.Fatalf("did not expect range probe rule for binary-only URL")
	}
}

func TestPromptRules_NonBinaryURL_RangeRule(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, baseRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "visit https://example.com/page", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if !strings.Contains(prompt, ruleRangeProbe) {
		t.Fatalf("expected range probe rule for non-binary URL")
	}
}

func TestPromptRules_PlanCreateRules_WhenToolRegistered(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	reg := baseRegistry()
	reg.Register(planCreateMarkerTool{})
	e := New(client, reg, baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "do a complex migration task", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if !strings.Contains(prompt, rulePlanGeneral) {
		t.Fatalf("expected plan general rule in prompt")
	}
	if !strings.Contains(prompt, rulePlanStepStatus) {
		t.Fatalf("expected plan step status rule in prompt")
	}
	if !strings.Contains(prompt, rulePlanCreateComplex) {
		t.Fatalf("expected plan_create complex-task rule in prompt")
	}
	if !strings.Contains(prompt, rulePlanCreateMode) {
		t.Fatalf("expected plan_create mode rule in prompt")
	}
	if !strings.Contains(prompt, rulePlanCreateFail) {
		t.Fatalf("expected plan_create fallback rule in prompt")
	}
}

func TestPromptRules_PlanCreateRules_NotInjected_WhenToolMissing(t *testing.T) {
	client := newMockClient(finalResponse("ok"))
	e := New(client, baseRegistry(), baseCfg(), DefaultPromptSpec())

	_, _, err := e.Run(context.Background(), "do a complex migration task", RunOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	prompt := client.allCalls()[0].Messages[0].Content
	if strings.Contains(prompt, rulePlanGeneral) {
		t.Fatalf("did not expect plan general rule without tool")
	}
	if strings.Contains(prompt, rulePlanStepStatus) {
		t.Fatalf("did not expect plan step status rule without tool")
	}
	if strings.Contains(prompt, rulePlanCreateComplex) {
		t.Fatalf("did not expect plan_create complex-task rule without tool")
	}
	if strings.Contains(prompt, rulePlanCreateMode) {
		t.Fatalf("did not expect plan_create mode rule without tool")
	}
	if strings.Contains(prompt, rulePlanCreateFail) {
		t.Fatalf("did not expect plan_create fallback rule without tool")
	}
}
