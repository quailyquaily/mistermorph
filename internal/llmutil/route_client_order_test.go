package llmutil

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
)

type routeOrderClient struct {
	call func(model, scene string) error
}

func (c routeOrderClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	return llm.Result{}, c.call(req.Model, req.Scene)
}

func (c routeOrderClient) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	return &llm.EvaluateResult{Model: req.Model}, c.call(req.Model, req.Scene)
}

func TestWeightedRouteFallbackOrder(t *testing.T) {
	for _, operation := range []string{"chat", "evaluate"} {
		for primary := 0; primary < 3; primary++ {
			t.Run(fmt.Sprintf("%s/primary=%d", operation, primary), func(t *testing.T) {
				var calls []string
				newClient := func(name string) llm.Client {
					return routeOrderClient{call: func(model, scene string) error {
						if model != name || scene != "decision-test" {
							t.Fatalf("client=%s model=%s scene=%s", name, model, scene)
						}
						calls = append(calls, name)
						if name == "backup" {
							return nil
						}
						return errors.New("http 429")
					}}
				}
				c := &weightedRouteClient{}
				for _, name := range []string{"a", "b", "c"} {
					c.candidates = append(c.candidates, weightedRouteCandidate{Profile: name, Model: name, Client: newClient(name)})
				}
				c.candidates[primary].Weight = 1
				c.fallbacks = []FallbackCandidate{{Profile: "backup", Model: "backup", Client: newClient("backup")}}
				ctx := llmstats.WithRunID(context.Background(), "stable-run")
				var err error
				if operation == "chat" {
					_, err = c.Chat(ctx, llm.Request{Model: "caller-model", Scene: "decision-test"})
				} else {
					_, err = c.Evaluate(ctx, llm.EvaluateRequest{Model: "caller-model", Scene: "decision-test"})
				}
				if err != nil {
					t.Fatal(err)
				}
				want := []string{c.candidates[primary].Model}
				for i, candidate := range c.candidates {
					if i != primary {
						want = append(want, candidate.Model)
					}
				}
				want = append(want, "backup")
				if !reflect.DeepEqual(calls, want) {
					t.Fatalf("calls=%v want %v", calls, want)
				}
			})
		}
	}
}
