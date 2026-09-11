package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

func TestParseFinalRejectsEmptyOutput(t *testing.T) {
	for _, responseType := range []string{"final", "final_answer"} {
		for _, fields := range []string{
			``, `,"output":null`, `,"output":""`, `,"output":" \n\t"`,
			`,"output":"null"`, `,"output":" null "`,
			`,"output":"\"\""`, `,"output":"\"null\""`,
			`,"final":{"output":"nested answer"}`, `,"reaction":"👍"`,
		} {
			t.Run(responseType+fields, func(t *testing.T) {
				_, err := ParseResponse(llm.Result{Text: fmt.Sprintf(`{"type":%q%s}`, responseType, fields)})
				if !errors.Is(err, ErrInvalidFinal) {
					t.Fatalf("ParseResponse() error = %v, want ErrInvalidFinal", err)
				}
			})
		}
	}
	_, err := ParseResponse(llm.Result{JSON: map[string]any{"type": "final", "output": nil}})
	if !errors.Is(err, ErrInvalidFinal) {
		t.Fatalf("structured result error = %v, want ErrInvalidFinal", err)
	}
}

func TestParseFinalPreservesUsableAndLightweightOutput(t *testing.T) {
	for _, fields := range []string{
		`"output":"answer"`, `"output":"null means no value"`,
		`"output":false`, `"output":0`, `"output":[]`, `"output":{}`,
		`"output":{"value":null}`, `"is_lightweight":true`,
		`"is_lightweight":true,"output":null,"reaction":"👍"`,
		`"is_lightweight":true,"output":""`,
	} {
		t.Run(fields, func(t *testing.T) {
			_, err := ParseResponse(llm.Result{Text: `{"type":"final",` + fields + `}`})
			if err != nil {
				t.Fatalf("ParseResponse() error = %v", err)
			}
		})
	}
}

func TestMainRequestResultValidation(t *testing.T) {
	request := (&Engine{}).mainRequest(&engineLoopState{}, nil)
	if request.ValidateResult == nil {
		t.Fatal("main request has no response validator")
	}
	for _, tc := range []struct {
		name    string
		result  llm.Result
		invalid bool
	}{
		{"empty", llm.Result{}, true},
		{"raw null", llm.Result{Text: " null "}, true},
		{"null final", llm.Result{Text: `{"type":"final","output":null}`}, true},
		{"blank final", llm.Result{Text: `{"type":"final","output":" "}`}, true},
		{"tools", llm.Result{ToolCalls: []llm.ToolCall{{Name: "read_file"}}}, false},
		{"tools with empty final text", llm.Result{Text: `{"type":"final"}`, ToolCalls: []llm.ToolCall{{Name: "read_file"}}}, false},
		{"plan", llm.Result{Text: `{"type":"plan","steps":[{"step":"read"}]}`}, false},
		{"lightweight", llm.Result{Text: `{"type":"final","is_lightweight":true}`}, false},
		{"structured output", llm.Result{JSON: map[string]any{"type": "final", "output": false}}, false},
		{"format retry", llm.Result{Text: "not JSON"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := request.ValidateResult(tc.result); (err != nil) != tc.invalid {
				t.Fatalf("validation error=%v, want invalid=%v", err, tc.invalid)
			}
		})
	}
}

func TestParseFinalAnswerUsesTopLevelOutput(t *testing.T) {
	resp, err := ParseResponse(llm.Result{Text: `{"type":"final_answer","output":"answer","final":{"output":"wrong"}}`})
	if err != nil || resp.FinalPayload().Output != "answer" {
		t.Fatalf("response=%+v err=%v, want top-level answer", resp, err)
	}
}

func TestAgentResponseHasRawFinalAnswerField(t *testing.T) {
	var resp AgentResponse
	if resp.RawFinalAnswer != nil {
		t.Error("expected RawFinalAnswer to default to nil")
	}
}

func TestParseFinalAnswerPopulatesRawFinalAnswer(t *testing.T) {
	input := `{
		"type": "final_answer",
		"reasoning": "done",
		"output": "hello",
		"sources": ["a", "b"]
	}`
	result := llm.Result{Text: input}
	resp, err := ParseResponse(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.RawFinalAnswer == nil {
		t.Fatal("expected RawFinalAnswer to be populated")
	}

	// RawFinalAnswer should contain the raw JSON payload without the top-level type.
	var m map[string]any
	if err := json.Unmarshal(resp.RawFinalAnswer, &m); err != nil {
		t.Fatalf("RawFinalAnswer is not valid JSON: %v", err)
	}
	if m["reasoning"] != "done" {
		t.Errorf("expected reasoning='done', got %v", m["reasoning"])
	}
	// Domain-specific field should be preserved
	sources, ok := m["sources"]
	if !ok {
		t.Fatal("expected 'sources' field in RawFinalAnswer")
	}
	arr, ok := sources.([]any)
	if !ok || len(arr) != 2 {
		t.Errorf("expected sources to be array of length 2, got %v", sources)
	}
}

func TestParseFinalPopulatesRawFinalAnswer(t *testing.T) {
	input := `{
		"type": "final",
		"reasoning": "done",
		"output": "result",
		"truth_assessment": 0.95
	}`
	result := llm.Result{Text: input}
	resp, err := ParseResponse(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.RawFinalAnswer == nil {
		t.Fatal("expected RawFinalAnswer to be populated for 'final' type")
	}

	var m map[string]any
	if err := json.Unmarshal(resp.RawFinalAnswer, &m); err != nil {
		t.Fatalf("RawFinalAnswer is not valid JSON: %v", err)
	}
	if m["truth_assessment"] != 0.95 {
		t.Errorf("expected truth_assessment=0.95, got %v", m["truth_assessment"])
	}
}

func TestParseToolCallRejected(t *testing.T) {
	input := `{
		"type": "tool_call",
		"tool_call": {
			"thought": "thinking",
			"tool_name": "search",
			"tool_params": {"q": "test"}
		}
	}`
	result := llm.Result{Text: input}
	_, err := ParseResponse(result)
	if err == nil {
		t.Fatal("expected tool_call to be rejected")
	}
}

func TestParseResponseTriesAllJSONCandidatesBeforeSchemaFailure(t *testing.T) {
	result := llm.Result{Text: `preface {"note":"not an agent response"} then {"type":"final","output":"done"}`}

	resp, err := ParseResponse(result)
	if err != nil {
		t.Fatalf("ParseResponse() error = %v", err)
	}
	if resp.Final == nil || resp.Final.Output != "done" {
		t.Fatalf("ParseResponse() = %#v, want final output done", resp)
	}
}
