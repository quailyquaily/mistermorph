package llmbench

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

// EvaluateProvider supports only Evaluate, so its profiles run just the Evaluate benchmark.
const EvaluateProvider = "typesafe"

// BenchmarkCount is how many benchmarks a profile with this provider runs.
func BenchmarkCount(provider string) int {
	if strings.EqualFold(strings.TrimSpace(provider), EvaluateProvider) {
		return 1
	}
	return BenchmarksPerRun
}

// RunEvaluateBenchmark checks that the client answers structured judgments the way the
// decision route asks them: a yes/no and a choice, both with obvious answers.
func RunEvaluateBenchmark(ctx context.Context, client llm.Client, model string) BenchmarkResult {
	const id = "evaluate"
	start := time.Now()
	res, err := llm.Evaluate(ctx, client, llm.EvaluateRequest{
		Model: strings.TrimSpace(model),
		Scene: "console.settings_test.evaluate",
		State: `The message is: "Can you check why the build failed and fix it?"`,
		Questions: map[string]llm.Question{
			"asks": {Kind: llm.Boolean, Instructions: "Does the message ask for something to be done?"},
			"reply": {Kind: llm.Choice, Instructions: "How should the message be answered?", Options: map[string]any{
				"text":  "Reply with text.",
				"emoji": "Reply with a single emoji only.",
			}},
		},
	})
	durationMS := time.Since(start).Milliseconds()
	if err != nil {
		message := strings.TrimSpace(err.Error())
		if errors.Is(err, llm.ErrEvaluateUnsupported) {
			message = "this client cannot answer structured judgments (Evaluate)"
		}
		return BenchmarkResult{ID: id, DurationMS: durationMS, Error: message, RawResponse: RawResponseFromError(err)}
	}
	raw := ""
	if res != nil {
		if data, marshalErr := json.MarshalIndent(res.Answers, "", "  "); marshalErr == nil {
			raw = string(data)
		}
	}
	if res == nil {
		return BenchmarkResult{ID: id, DurationMS: durationMS, Error: "received no answers"}
	}
	asks, reply := res.Answers["asks"], res.Answers["reply"]
	if asks.Kind != llm.Boolean || reply.Kind != llm.Choice {
		return BenchmarkResult{ID: id, DurationMS: durationMS, Error: "the answers do not match the questions", RawResponse: raw}
	}
	yes := (asks.BooleanValue != nil && *asks.BooleanValue) || (asks.ProbabilityTrue != nil && *asks.ProbabilityTrue > 0.5)
	if !yes || reply.Selected != "text" {
		return BenchmarkResult{ID: id, DurationMS: durationMS, Error: "answered an obvious judgment wrongly", RawResponse: raw}
	}
	mode := "native"
	if res.Emulated {
		mode = "emulated through chat"
	}
	return BenchmarkResult{ID: id, OK: true, DurationMS: durationMS, Detail: "judgments answered correctly (" + mode + ")", RawResponse: raw}
}
