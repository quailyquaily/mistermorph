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
	Addressed      bool
	Confidence     float64
	WannaInterject bool
	Interject      float64
	Impulse        float64
	IsLightweight  bool
	Reaction       string
	Reason         string
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
	ReactionTool             tools.Tool
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
		if llmDec.Addressed && llmDec.Confidence >= confidenceThreshold {
			dec.UsedAddressingLLM = true
			return finishDecision(addrCtx, dec, opts.ReactionTool)
		}
		dec.Reason = "not_addressed"
		if llmDec.Addressed {
			dec.Reason = "below_threshold"
		}
	case "talkative":
		if llmDec.WannaInterject && llmDec.Interject > interjectThreshold {
			dec.UsedAddressingLLM = true
			return finishDecision(addrCtx, dec, opts.ReactionTool)
		}
		dec.Reason = "below_threshold"
	}
	return dec, false, nil
}

// finishDecision applies a constrained reaction only after the response gate.
func finishDecision(ctx context.Context, dec Decision, reactionTool tools.Tool) (Decision, bool, error) {
	if err := ctx.Err(); err != nil {
		return dec, false, err
	}
	if !dec.Addressing.IsLightweight {
		return dec, true, nil
	}
	if reactionTool == nil || dec.Addressing.Reaction == "" {
		return dec, false, fmt.Errorf("reaction selected without executable reaction")
	}
	if _, err := reactionTool.Execute(ctx, map[string]any{"emoji": dec.Addressing.Reaction}); err != nil {
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
