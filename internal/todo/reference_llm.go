package todo

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/llm"
)

type MissingReference struct {
	Mention    string `json:"mention"`
	Suggestion string `json:"suggestion,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type MissingReferenceIDError struct {
	Items []MissingReference
}

func (e *MissingReferenceIDError) Error() string {
	if e == nil || len(e.Items) == 0 {
		return "missing_reference_id"
	}
	first := e.Items[0]
	mention := strings.TrimSpace(first.Mention)
	suggestion := strings.TrimSpace(first.Suggestion)
	switch {
	case mention != "" && suggestion != "":
		return fmt.Sprintf("missing_reference_id: mention=%q suggestion=%q", mention, suggestion)
	case mention != "":
		return fmt.Sprintf("missing_reference_id: mention=%q", mention)
	default:
		return "missing_reference_id"
	}
}

type LLMReferenceResolver struct {
	Client llm.Client
	Model  string
}

func NewLLMReferenceResolver(client llm.Client, model string) *LLMReferenceResolver {
	return &LLMReferenceResolver{
		Client: client,
		Model:  strings.TrimSpace(model),
	}
}

func (r *LLMReferenceResolver) ResolveAddContent(ctx context.Context, content string, snapshot ContactSnapshot) (string, []string, error) {
	if err := r.validateReady(); err != nil {
		return "", nil, err
	}
	content = strings.TrimSpace(content)
	if content == "" {
		return "", nil, fmt.Errorf("content is required")
	}
	payload := map[string]any{
		"content":      content,
		"contacts":     snapshot.Contacts,
		"allowed_ids":  snapshot.ReachableIDs,
		"output_rules": []string{"strict_json_only"},
	}
	input, _ := json.Marshal(payload)
	systemPrompt := strings.Join([]string{
		"You rewrite TODO add content by attaching explicit reference IDs to object mentions.",
		"Return strict JSON only.",
		`Output schema: {"status":"ok","rewritten_content":"...","warnings":["..."]} OR {"status":"missing_reference_id","missing":[{"mention":"...","suggestion":"Name (id)","reason":"..."}]}.`,
		"Preserve the original language and intent.",
		"If a mentioned object can be resolved to one allowed_id, rewrite as Name (id).",
		"If any mentioned object lacks a resolvable allowed_id, return status=missing_reference_id.",
		"Never invent IDs that are not listed in allowed_ids.",
		"When content already has valid references, keep it stable.",
	}, " ")

	res, err := r.Client.Chat(ctx, llm.Request{
		Model:     r.Model,
		ForceJSON: true,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: string(input)},
		},
		Parameters: map[string]any{
			"temperature": 0,
			"max_tokens":  1200,
		},
	})
	if err != nil {
		return "", nil, err
	}

	var out struct {
		Status    string             `json:"status"`
		Rewritten string             `json:"rewritten_content"`
		Warnings  []string           `json:"warnings,omitempty"`
		Missing   []MissingReference `json:"missing,omitempty"`
	}
	if err := decodeStrictJSON(res.Text, &out); err != nil {
		return "", nil, fmt.Errorf("invalid reference_resolve response: %w", err)
	}

	switch strings.ToLower(strings.TrimSpace(out.Status)) {
	case "ok":
		rewritten := strings.TrimSpace(out.Rewritten)
		if rewritten == "" {
			return "", nil, fmt.Errorf("reference_resolve returned empty rewritten_content")
		}
		return rewritten, normalizeWarnings(out.Warnings), nil
	case "missing_reference_id":
		items := normalizeMissingReferences(out.Missing)
		if len(items) == 0 {
			return "", nil, &MissingReferenceIDError{}
		}
		return "", nil, &MissingReferenceIDError{Items: items}
	default:
		return "", nil, fmt.Errorf("invalid reference_resolve status: %s", strings.TrimSpace(out.Status))
	}
}

func (r *LLMReferenceResolver) validateReady() error {
	if r == nil || r.Client == nil {
		return fmt.Errorf("todo reference resolver missing llm client")
	}
	if strings.TrimSpace(r.Model) == "" {
		return fmt.Errorf("todo reference resolver missing llm model")
	}
	return nil
}

func normalizeMissingReferences(items []MissingReference) []MissingReference {
	if len(items) == 0 {
		return nil
	}
	out := make([]MissingReference, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		n := MissingReference{
			Mention:    strings.TrimSpace(item.Mention),
			Suggestion: strings.TrimSpace(item.Suggestion),
			Reason:     strings.TrimSpace(item.Reason),
		}
		if n.Mention == "" && n.Suggestion == "" {
			continue
		}
		key := n.Mention + "|" + n.Suggestion
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, n)
	}
	return out
}

func normalizeWarnings(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, raw := range items {
		v := strings.TrimSpace(raw)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}
