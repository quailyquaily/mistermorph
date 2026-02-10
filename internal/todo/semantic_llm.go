package todo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
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

func (r *LLMSemanticResolver) SelectDedupKeepIndices(ctx context.Context, items []entryutil.SemanticItem) ([]int, error) {
	resolver := entryutil.NewLLMSemanticResolver(r.Client, r.Model)
	return resolver.SelectDedupKeepIndices(ctx, items)
}

func (r *LLMSemanticResolver) MatchCompleteIndex(ctx context.Context, query string, entries []Entry) (int, error) {
	if err := r.validateReady(); err != nil {
		return -1, err
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return -1, fmt.Errorf("content is required")
	}
	if len(entries) == 0 {
		return -1, fmt.Errorf("no matching todo item in TODO.md")
	}

	items := make([]map[string]any, 0, len(entries))
	for i, item := range entries {
		items = append(items, map[string]any{
			"index":      i,
			"created_at": strings.TrimSpace(item.CreatedAt),
			"content":    strings.TrimSpace(item.Content),
		})
	}
	payload, _ := json.Marshal(map[string]any{
		"query": query,
		"items": items,
	})
	systemPrompt := strings.Join([]string{
		"You pick exactly one TODO.WIP entry to complete, using semantic matching.",
		"Return strict JSON only.",
		"Output schema:",
		"{\"status\":\"matched\",\"index\":1} OR {\"status\":\"no_match\"} OR {\"status\":\"ambiguous\",\"candidate_indices\":[1,3]}",
		"If there is no confident match, return no_match.",
		"If multiple entries are plausible, return ambiguous with candidate_indices.",
		"Index values must refer to existing input entries.",
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
			"max_tokens":  500,
		},
	})
	if err != nil {
		return -1, err
	}

	var out struct {
		Status           string `json:"status"`
		Index            *int   `json:"index,omitempty"`
		CandidateIndices []int  `json:"candidate_indices,omitempty"`
	}
	if err := decodeStrictJSON(res.Text, &out); err != nil {
		return -1, fmt.Errorf("invalid semantic_match response: %w", err)
	}

	switch strings.ToLower(strings.TrimSpace(out.Status)) {
	case "matched":
		if out.Index == nil {
			return -1, fmt.Errorf("semantic match missing index")
		}
		if *out.Index < 0 || *out.Index >= len(entries) {
			return -1, fmt.Errorf("semantic match index out of range: %d", *out.Index)
		}
		return *out.Index, nil
	case "no_match":
		return -1, fmt.Errorf("no matching todo item in TODO.md")
	case "ambiguous":
		if len(out.CandidateIndices) == 0 {
			return -1, fmt.Errorf("ambiguous todo item match")
		}
		for _, idx := range out.CandidateIndices {
			if idx < 0 || idx >= len(entries) {
				return -1, fmt.Errorf("semantic ambiguous index out of range: %d", idx)
			}
		}
		return -1, fmt.Errorf("ambiguous todo item match")
	default:
		return -1, fmt.Errorf("invalid semantic match status: %s", strings.TrimSpace(out.Status))
	}
}

func (r *LLMSemanticResolver) validateReady() error {
	if r == nil || r.Client == nil {
		return fmt.Errorf("todo semantic resolver missing llm client")
	}
	if strings.TrimSpace(r.Model) == "" {
		return fmt.Errorf("todo semantic resolver missing llm model")
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
