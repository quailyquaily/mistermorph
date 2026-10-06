package grouptrigger

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type Decision struct {
	ReactionHandled   bool
	Reason            string
	UsedAddressingLLM bool

	AddressingLLMAttempted bool
	AddressingLLMOK        bool
	Addressing             Addressing
}

type Addressing struct {
	Model string
	// Confidence is how likely the message is addressed to the agent (0-1); smart mode accepts it
	// at addressing_confidence_threshold or above.
	Confidence float64
	// Interject is how strongly the agent wants to join (0-1); talkative mode accepts it above
	// addressing_interject_threshold.
	Interject     float64
	Impulse       float64
	IsLightweight bool
	Reaction      string
	Reason        string
}

type AddressingFunc func(ctx context.Context) (Addressing, bool, error)

type DecideOptions struct {
	Mode                     string
	ConfidenceThreshold      float64
	InterjectThreshold       float64
	ExplicitReason           string
	ExplicitMatched          bool
	AddressingFallbackReason string
	AddressingTimeout        time.Duration
	Addressing               AddressingFunc
	// React delivers the chosen emoji: a native reaction, or a message where the channel has none.
	React func(ctx context.Context, emoji string) error
}

type LLMDecisionOptions struct {
	Client       llm.Client
	Model        string
	Scene        string
	SystemPrompt string
	UserPrompt   string
	// An empty list permits only text; the caller owns reaction capability.
	ReactionEmojis []string
}

func Decide(ctx context.Context, opts DecideOptions) (Decision, bool, error) {
	mode := strings.ToLower(strings.TrimSpace(opts.Mode))
	if mode == "" {
		mode = "smart"
	}

	confidenceThreshold := clamp01(opts.ConfidenceThreshold)

	interjectThreshold := clamp01(opts.InterjectThreshold)

	if opts.ExplicitMatched {
		return Decision{
			Reason: strings.TrimSpace(opts.ExplicitReason),
			Addressing: Addressing{
				Impulse: 1,
			},
		}, true, nil
	}

	if mode != "talkative" && mode != "smart" {
		return Decision{}, false, nil
	}

	dec := Decision{
		AddressingLLMAttempted: true,
		Reason:                 strings.TrimSpace(opts.AddressingFallbackReason),
	}
	if opts.Addressing == nil {
		return dec, false, nil
	}

	addrCtx := ctx
	if addrCtx == nil {
		addrCtx = context.Background()
	}
	cancel := func() {}
	if opts.AddressingTimeout > 0 {
		addrCtx, cancel = context.WithTimeout(addrCtx, opts.AddressingTimeout)
	}
	defer cancel()
	llmDec, llmOK, llmErr := opts.Addressing(addrCtx)
	if llmErr != nil {
		return dec, false, llmErr
	}
	if err := addrCtx.Err(); err != nil {
		return dec, false, err
	}
	llmDec = normalizeAddressing(llmDec)

	dec.AddressingLLMOK = llmOK
	dec.Addressing = llmDec
	if llmDec.Reason != "" {
		dec.Reason = llmDec.Reason
	}
	if !llmOK {
		return dec, false, nil
	}

	switch mode {
	case "smart":
		if llmDec.Confidence >= confidenceThreshold {
			dec.UsedAddressingLLM = true
			return finishDecision(addrCtx, dec, opts.React)
		}
		dec.Reason = "below_threshold"
	case "talkative":
		if llmDec.Interject > interjectThreshold {
			dec.UsedAddressingLLM = true
			return finishDecision(addrCtx, dec, opts.React)
		}
		dec.Reason = "below_threshold"
	}
	return dec, false, nil
}

// finishDecision applies a constrained reaction only after the response gate.
func finishDecision(ctx context.Context, dec Decision, react func(context.Context, string) error) (Decision, bool, error) {
	if err := ctx.Err(); err != nil {
		return dec, false, err
	}
	if !dec.Addressing.IsLightweight {
		return dec, true, nil
	}
	if react == nil || dec.Addressing.Reaction == "" {
		return dec, false, fmt.Errorf("reaction selected without executable reaction")
	}
	if err := react(ctx, dec.Addressing.Reaction); err != nil {
		return dec, false, err
	}
	dec.ReactionHandled = true
	return dec, true, nil
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func normalizeAddressing(in Addressing) Addressing {
	in.Confidence = clamp01(in.Confidence)
	in.Interject = clamp01(in.Interject)
	in.Impulse = clamp01(in.Impulse)
	in.Reason = strings.TrimSpace(in.Reason)
	return in
}

// ReactWith adapts a channel's message_react tool to DecideOptions.React; nil gives nil.
func ReactWith(tool tools.Tool) func(context.Context, string) error {
	if tool == nil {
		return nil
	}
	return func(ctx context.Context, emoji string) error {
		_, err := tool.Execute(ctx, map[string]any{"emoji": emoji})
		return err
	}
}
