package agent

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/jsonutil"
	"github.com/quailyquaily/mistermorph/llm"
)

var (
	ErrParseFailure    = errors.New("failed to parse agent response from LLM output")
	ErrInvalidToolCall = errors.New("tool_call JSON responses are not supported")
	ErrInvalidPlan     = errors.New("plan response missing payload")
	ErrInvalidFinal    = errors.New("final response missing non-empty output")
)

func ParseResponse(result llm.Result) (*AgentResponse, error) {
	return parseResponse(result, false)
}

// parseResponse parses the model's response. allowEmptyFinal accepts a final without output as a
// lightweight one: after a reaction in the same run, an empty final means the reaction was the
// whole reply.
func parseResponse(result llm.Result, allowEmptyFinal bool) (*AgentResponse, error) {
	var lastErr error

	if result.JSON != nil {
		data, err := json.Marshal(result.JSON)
		if err == nil {
			resp, err := unmarshalAndValidate(data, allowEmptyFinal)
			if err == nil {
				return resp, nil
			}
			lastErr = err
		}
	}

	text := strings.TrimSpace(result.Text)
	if text == "" {
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, ErrParseFailure
	}

	if candidates, err := jsonutil.FindJSONCandidates(text); err == nil {
		for _, data := range candidates {
			resp, err := unmarshalAndValidate(data, allowEmptyFinal)
			if err == nil {
				return resp, nil
			}
			lastErr = err
		}
	} else {
		lastErr = err
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, ErrParseFailure
}

func unmarshalAndValidate(data []byte, allowEmptyFinal bool) (*AgentResponse, error) {
	var resp AgentResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, err
	}

	switch resp.Type {
	case TypePlan:
		var plan Plan
		if err := json.Unmarshal(data, &plan); err != nil {
			return nil, err
		}
		resp.Plan = &plan
	case TypeFinal, TypeFinalAnswer:
		var final Final
		if err := json.Unmarshal(data, &final); err != nil {
			return nil, err
		}
		resp.Final, resp.FinalAnswer = nil, nil
		if resp.Type == TypeFinalAnswer {
			resp.FinalAnswer = &final
		} else {
			resp.Final = &final
		}
		if raw, err := rawResponsePayload(data); err == nil {
			resp.RawFinalAnswer = raw
		}
	}

	return validate(&resp, allowEmptyFinal)
}

func rawResponsePayload(data []byte) (json.RawMessage, error) {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	delete(payload, "type")
	return json.Marshal(payload)
}

func validate(resp *AgentResponse, allowEmptyFinal bool) (*AgentResponse, error) {
	switch resp.Type {
	case TypeToolCall:
		return nil, ErrInvalidToolCall
	case TypePlan:
		if resp.PlanPayload() == nil {
			return nil, ErrInvalidPlan
		}
	case TypeFinal, TypeFinalAnswer:
		final := resp.FinalPayload()
		if final == nil {
			return nil, ErrInvalidFinal
		}
		if !final.IsLightweight && finalOutputEmpty(final.Output) {
			if !allowEmptyFinal {
				return nil, ErrInvalidFinal
			}
			final.IsLightweight = true
		}
	default:
		return nil, ErrParseFailure
	}
	return resp, nil
}

func finalOutputEmpty(output any) bool {
	if output == nil {
		return true
	}
	text, ok := output.(string)
	if !ok {
		return false
	}
	text = strings.TrimSpace(text)
	var decoded string
	if json.Unmarshal([]byte(text), &decoded) == nil {
		text = strings.TrimSpace(decoded)
	}
	return text == "" || text == "null"
}

func validateMainResult(result llm.Result) error {
	return checkMainResult(result, false)
}

// validateMainResultAfterReaction is validateMainResult for a run that has already reacted, where
// a final without output is the expected end.
func validateMainResultAfterReaction(result llm.Result) error {
	return checkMainResult(result, true)
}

func checkMainResult(result llm.Result, allowEmptyFinal bool) error {
	if len(result.ToolCalls) > 0 {
		return nil
	}
	if text := strings.TrimSpace(result.Text); result.JSON == nil && (text == "" || text == "null") {
		return ErrInvalidFinal
	}
	_, err := parseResponse(result, allowEmptyFinal)
	if errors.Is(err, ErrInvalidFinal) {
		return err
	}
	// Other format errors retain the engine's corrective-prompt retry flow.
	return nil
}
