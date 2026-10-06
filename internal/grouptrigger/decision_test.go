package grouptrigger

import (
	"context"
	"errors"
	"testing"
)

func TestDecideExplicitMatched(t *testing.T) {
	t.Parallel()

	called := false
	dec, ok, err := Decide(context.Background(), DecideOptions{
		Mode:            "smart",
		ExplicitReason:  "mention",
		ExplicitMatched: true,
		Addressing: func(ctx context.Context) (Addressing, bool, error) {
			called = true
			return Addressing{}, false, nil
		},
	})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if !ok {
		t.Fatalf("Decide() ok=false, want true")
	}
	if called {
		t.Fatalf("addressing should not be called on explicit match")
	}
	if dec.Reason != "mention" {
		t.Fatalf("reason mismatch: got %q want %q", dec.Reason, "mention")
	}
	if dec.Addressing.Impulse != 1 {
		t.Fatalf("impulse mismatch: got %v want 1", dec.Addressing.Impulse)
	}
}

func TestDecideStrictWithoutExplicit(t *testing.T) {
	t.Parallel()

	called := false
	_, ok, err := Decide(context.Background(), DecideOptions{
		Mode: "strict",
		Addressing: func(ctx context.Context) (Addressing, bool, error) {
			called = true
			return Addressing{}, false, nil
		},
	})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if ok {
		t.Fatalf("Decide() ok=true, want false")
	}
	if called {
		t.Fatalf("addressing should not be called in strict mode without explicit trigger")
	}
}

func TestDecideUsesOnlyTheModeThreshold(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		mode       string
		confidence float64
		interject  float64
		want       bool
		wantReason string
	}{
		{name: "smart at threshold", mode: "smart", confidence: 0.6, want: true},
		{name: "smart below threshold", mode: "smart", confidence: 0.59, interject: 1, wantReason: "below_threshold"},
		{name: "smart ignores interject", mode: "smart", confidence: 0.95, interject: 0.1, want: true},
		{name: "talkative above threshold", mode: "talkative", interject: 0.8, want: true},
		{name: "talkative at threshold", mode: "talkative", confidence: 1, interject: 0.5, wantReason: "below_threshold"},
		{name: "talkative ignores confidence", mode: "talkative", confidence: 0.1, interject: 0.9, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dec, ok, err := Decide(context.Background(), DecideOptions{
				Mode:                tt.mode,
				ConfidenceThreshold: 0.6,
				InterjectThreshold:  0.5,
				Addressing: func(ctx context.Context) (Addressing, bool, error) {
					return Addressing{Confidence: tt.confidence, Interject: tt.interject}, true, nil
				},
			})
			if err != nil {
				t.Fatalf("Decide() error = %v", err)
			}
			if ok != tt.want {
				t.Fatalf("Decide() ok = %v, want %v", ok, tt.want)
			}
			if !ok && dec.Reason != tt.wantReason {
				t.Fatalf("reason = %q, want %q", dec.Reason, tt.wantReason)
			}
		})
	}
}

func TestDecideAddressingError(t *testing.T) {
	t.Parallel()

	expected := errors.New("boom")
	_, _, err := Decide(context.Background(), DecideOptions{
		Mode: "smart",
		Addressing: func(ctx context.Context) (Addressing, bool, error) {
			return Addressing{}, false, expected
		},
	})
	if !errors.Is(err, expected) {
		t.Fatalf("Decide() error = %v, want %v", err, expected)
	}
}
