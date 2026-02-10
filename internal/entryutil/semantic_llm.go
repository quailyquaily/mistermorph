package entryutil

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/llm"
)

type LLMSemanticResolver struct {
	Client llm.Client
	Model  string
}

func NewLLMSemanticResolver(client llm.Client, model string) *LLMSemanticResolver {
	return &LLMSemanticResolver{
		Client: client,
		Model:  strings.TrimSpace(model),
	}
}

func (r *LLMSemanticResolver) SelectDedupKeepIndices(ctx context.Context, items []SemanticItem) ([]int, error) {
	if err := r.validateReady(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("no entries to dedupe")
	}

	payloadItems := make([]map[string]any, 0, len(items))
	for i, item := range items {
		payloadItems = append(payloadItems, map[string]any{
			"index":      i,
			"created_at": strings.TrimSpace(item.CreatedAt),
			"content":    strings.TrimSpace(item.Content),
		})
	}
	payload, _ := json.Marshal(map[string]any{"items": payloadItems})
	systemPrompt := strings.Join([]string{
		"You deduplicate newest-first memory-like entries.",
		"Return strict JSON only.",
		"Output schema: {\"keep_indices\":[0,2]}",
		"Entries are listed newest-first (index 0 is newest).",
		"When items are semantically duplicates, keep only one representative.",
		"Prefer the entry with clearer action detail and explicit reference ids in parentheses.",
		"keep_indices must contain unique integer indices that exist in input.",
		"keep_indices must not be empty.",
	}, " ")

	res, err := r.Client.Chat(ctx, llm.Request{
		Model:     r.Model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: string(payload)},
		},
		Parameters: map[string]any{
			"temperature": 0,
			"max_tokens":  600,
		},
	})
	if err != nil {
		return nil, err
	}

	var out struct {
		KeepIndices []int `json:"keep_indices"`
	}
	if err := decodeStrictJSON(res.Text, &out); err != nil {
		return nil, fmt.Errorf("invalid semantic_dedup response: %w", err)
	}
	if len(out.KeepIndices) == 0 {
		return nil, fmt.Errorf("semantic dedupe returned empty keep_indices")
	}

	seen := make(map[int]bool, len(out.KeepIndices))
	indices := make([]int, 0, len(out.KeepIndices))
	for _, idx := range out.KeepIndices {
		if idx < 0 || idx >= len(items) {
			return nil, fmt.Errorf("semantic dedupe index out of range: %d", idx)
		}
		if seen[idx] {
			continue
		}
		seen[idx] = true
		indices = append(indices, idx)
	}
	sort.Ints(indices)
	return indices, nil
}

func (r *LLMSemanticResolver) validateReady() error {
	if r == nil || r.Client == nil {
		return fmt.Errorf("semantic resolver missing llm client")
	}
	if strings.TrimSpace(r.Model) == "" {
		return fmt.Errorf("semantic resolver missing llm model")
	}
	return nil
}

func decodeStrictJSON(raw string, dst any) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("empty llm response")
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != nil {
		if err == io.EOF {
			return nil
		}
		return err
	}
	return fmt.Errorf("extra non-json payload detected")
}
