// Package memorytools gives a run the tools to save and find memories and to search the journal.
// Each tool is built for one run's audience, so a tool never reads or writes for anyone else; the
// rules themselves are in the memories package and the journal's audience column.
package memorytools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/domainjournal"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/memories"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	SaveName          = "memory_save"
	SearchName        = "memory_search"
	ForgetName        = "memory_forget"
	JournalSearchName = "journal_search"
	JournalReadName   = "journal_read"

	maxExcerptRunes    = 300
	maxJournalReadSize = 8 << 10
)

// Deps is what the tools of one run use.
type Deps struct {
	Store      *memories.Store
	JournalDir string
	Audience   audience.Audience
	// ReadOnly leaves out memory_save and memory_forget, for runs that read the owner's memories
	// but must not change them, such as awareness tasks.
	ReadOnly bool
}

// New returns the tools for one run. memory_save is always visible; the others are found with
// tool_search when it is on.
func New(deps Deps) []tools.Tool {
	var out []tools.Tool
	if !deps.ReadOnly {
		out = append(out, &saveTool{deps: deps})
	}
	out = append(out, &searchTool{deps: deps})
	if !deps.ReadOnly {
		out = append(out, &forgetTool{deps: deps})
	}
	if strings.TrimSpace(deps.JournalDir) != "" {
		out = append(out, &journalSearchTool{deps: deps}, &journalReadTool{deps: deps})
	}
	return out
}

// Catalog is every memory tool, built without dependencies, for listing their schemas.
func Catalog() []tools.Tool {
	return New(Deps{JournalDir: "-"})
}

func schema(properties map[string]any, required ...string) string {
	s := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		s["required"] = required
	}
	raw, _ := json.Marshal(s)
	return string(raw)
}

func prop(typ, description string) map[string]any {
	return map[string]any{"type": typ, "description": description}
}

func result(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func stringParam(params map[string]any, key string) string {
	v, _ := params[key].(string)
	return strings.TrimSpace(v)
}

func intParam(params map[string]any, key string) int {
	switch v := params[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	}
	return 0
}

func stringsParam(params map[string]any, key string) []string {
	raw, _ := params[key].([]any)
	var out []string
	for _, item := range raw {
		if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

func noAudience() error {
	return errors.New("this run has no audience, so it has no memories or journal")
}

// memoryView is a memory as the tools show it.
type memoryView struct {
	ID          string `json:"id"`
	Subject     string `json:"subject"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Body        string `json:"body"`
	Visibility  string `json:"visibility"`
	ToldBy      string `json:"told_by,omitempty"`
	UpdatedAt   string `json:"updated_at"`
}

func viewOf(m memories.Memory) memoryView {
	return memoryView{
		ID: m.ID, Subject: m.Subject, Name: m.Name, Type: string(m.Type), Description: m.Description, Body: m.Body,
		Visibility: string(m.Visibility), ToldBy: m.ToldBy, UpdatedAt: m.UpdatedAt,
	}
}

type saveTool struct{ deps Deps }

func (t *saveTool) Name() string { return SaveName }

func (t *saveTool) Description() string {
	return "Saves a memory: a fact you cannot get back from the conversation or the journal that will change a later answer, such as a correction, a preference, who someone is, a goal or a deadline. " +
		"Saving with the subject and name of an existing memory replaces it. Never save summaries of what was done, things that matter only in this task, or secrets."
}

func (t *saveTool) ParameterSchema() string {
	return schema(map[string]any{
		"subject":       prop("string", "Who or what the memory is about: owner, general, contact:<contact id>, or conversation:<conversation key>. Defaults to the person or group you are talking with."),
		"name":          prop("string", "Kebab-case slug, unique per subject, such as release-notes-delivery. Reuse a name to update that memory."),
		"type":          map[string]any{"type": "string", "enum": []string{"person", "feedback", "context", "reference"}, "description": "person: who someone is. feedback: how to work, with why. context: goals, deadlines, constraints, with absolute dates. reference: where something lives."},
		"description":   prop("string", "One line saying what the memory is, used to find it later."),
		"body":          prop("string", "The fact. For feedback and context, follow it with 'Why:' and 'How to apply:' lines."),
		"visibility":    map[string]any{"type": "string", "enum": []string{"private", "conversation", "public"}, "description": "Who may hear it. Omit for the default, which keeps it where it was learned."},
		"source_events": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Optional journal event ids the memory comes from."},
	}, "name", "type", "description", "body")
}

func (t *saveTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t.deps.Store == nil || t.deps.Audience.IsZero() {
		return "", noAudience()
	}
	subject := stringParam(params, "subject")
	if subject == "" {
		subject = t.deps.Audience.String()
	}
	res, err := t.deps.Store.Save(ctx, t.deps.Audience, memories.Draft{
		Subject:      subject,
		Name:         stringParam(params, "name"),
		Type:         memories.Type(stringParam(params, "type")),
		Description:  stringParam(params, "description"),
		Body:         stringParam(params, "body"),
		Visibility:   memories.Visibility(stringParam(params, "visibility")),
		SourceEvents: stringsParam(params, "source_events"),
		TaskID:       llmstats.RunIDFromContext(ctx),
	})
	if err != nil {
		return "", err
	}
	status := "replaced"
	if res.Created {
		status = "created"
	}
	return result(map[string]any{
		"status":     status,
		"id":         res.Memory.ID,
		"subject":    res.Memory.Subject,
		"name":       res.Memory.Name,
		"visibility": res.Memory.Visibility,
		"notes":      res.Notes,
	})
}

type searchTool struct{ deps Deps }

func (t *searchTool) Name() string   { return SearchName }
func (t *searchTool) Deferred() bool { return true }
func (t *searchTool) ParallelSafe() bool {
	return true
}

func (t *searchTool) Description() string {
	return "Searches the memories you may use here by their words, newest first. Use it before saving, to update a memory instead of adding one that overlaps it, and when a memory you need is not in the prompt."
}

func (t *searchTool) ParameterSchema() string {
	return schema(map[string]any{
		"query":   prop("string", "Words that must all appear. Omit to list."),
		"subject": prop("string", "Only memories about this subject."),
		"type":    prop("string", "Only memories of this type: person, feedback, context or reference."),
		"limit":   prop("integer", "At most this many, 1-50. Default 10."),
	})
}

func (t *searchTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t.deps.Store == nil || t.deps.Audience.IsZero() {
		return "", noAudience()
	}
	items, more, err := t.deps.Store.Search(ctx, t.deps.Audience, memories.SearchOptions{
		Query:   stringParam(params, "query"),
		Subject: stringParam(params, "subject"),
		Type:    memories.Type(stringParam(params, "type")),
		Limit:   intParam(params, "limit"),
	})
	if err != nil {
		return "", err
	}
	views := make([]memoryView, 0, len(items))
	for _, m := range items {
		views = append(views, viewOf(m))
	}
	return result(map[string]any{"memories": views, "has_more": more})
}

type forgetTool struct{ deps Deps }

func (t *forgetTool) Name() string   { return ForgetName }
func (t *forgetTool) Deferred() bool { return true }

func (t *forgetTool) Description() string {
	return "Deletes a memory that turned out to be wrong or no longer holds, by its id from memory_search or the prompt."
}

func (t *forgetTool) ParameterSchema() string {
	return schema(map[string]any{"id": prop("string", "The memory's id.")}, "id")
}

func (t *forgetTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t.deps.Store == nil || t.deps.Audience.IsZero() {
		return "", noAudience()
	}
	id := stringParam(params, "id")
	if id == "" {
		return "", errors.New("id is required")
	}
	forgotten, err := t.deps.Store.Forget(ctx, t.deps.Audience, id)
	if err != nil {
		return "", err
	}
	if !forgotten {
		return "", fmt.Errorf("no memory %s here", id)
	}
	return result(map[string]any{"forgotten": id})
}

// journalAudiences is which journal events an audience may hear: all of them for the owner, and
// only its own for anyone else.
func journalAudiences(a audience.Audience) ([]string, bool) {
	if a.Kind == audience.KindOwner {
		return nil, true
	}
	if a.IsZero() {
		return nil, false
	}
	return []string{a.String()}, false
}

func canHearEvent(a audience.Audience, event domainjournal.Event) bool {
	if a.Kind == audience.KindOwner {
		return true
	}
	return !a.IsZero() && event.Audience == a.String()
}

type journalSearchTool struct{ deps Deps }

func (t *journalSearchTool) Name() string       { return JournalSearchName }
func (t *journalSearchTool) Deferred() bool     { return true }
func (t *journalSearchTool) ParallelSafe() bool { return true }

func (t *journalSearchTool) Description() string {
	return "Searches the journal, the raw record of what was asked and answered, for what people said here. Use it when a memory seems wrong or missing, or to check what really happened. Results are newest first."
}

func (t *journalSearchTool) ParameterSchema() string {
	return schema(map[string]any{
		"query":  prop("string", "Words that must all appear. Omit to list by time."),
		"since":  prop("string", "Only events at or after this time: RFC 3339 or YYYY-MM-DD."),
		"until":  prop("string", "Only events before this time: RFC 3339 or YYYY-MM-DD."),
		"domain": prop("string", "Only this domain, such as task or conversation."),
		"limit":  prop("integer", "At most this many, 1-100. Default 20."),
	})
}

func parseTime(raw string) (time.Time, error) {
	if raw == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("time %q must be RFC 3339 or YYYY-MM-DD", raw)
}

func (t *journalSearchTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t.deps.Audience.IsZero() || strings.TrimSpace(t.deps.JournalDir) == "" {
		return "", noAudience()
	}
	since, err := parseTime(stringParam(params, "since"))
	if err != nil {
		return "", err
	}
	until, err := parseTime(stringParam(params, "until"))
	if err != nil {
		return "", err
	}
	audiences, all := journalAudiences(t.deps.Audience)
	journal, err := domainjournal.New(domainjournal.JournalOptions{Dir: t.deps.JournalDir})
	if err != nil {
		return "", err
	}
	defer func() { _ = journal.Close() }()
	hits, more, err := journal.Search(domainjournal.SearchOptions{
		Query:        stringParam(params, "query"),
		Audiences:    audiences,
		AllAudiences: all,
		Since:        since,
		Until:        until,
		Domain:       stringParam(params, "domain"),
		Limit:        intParam(params, "limit"),
	})
	if err != nil {
		return "", err
	}
	type hitView struct {
		Seq    int64  `json:"seq"`
		ID     string `json:"id"`
		Time   string `json:"time"`
		Domain string `json:"domain"`
		Type   string `json:"type"`
		TaskID string `json:"task_id,omitempty"`
		Text   string `json:"text"`
	}
	views := make([]hitView, 0, len(hits))
	for _, hit := range hits {
		views = append(views, hitView{
			Seq: hit.Ref.Seq, ID: hit.ID, Time: hit.Time, Domain: hit.Domain, Type: hit.Type, TaskID: hit.Trace.TaskID,
			Text: excerpt(hit.Text, maxExcerptRunes),
		})
	}
	return result(map[string]any{"events": views, "has_more": more})
}

type journalReadTool struct{ deps Deps }

func (t *journalReadTool) Name() string       { return JournalReadName }
func (t *journalReadTool) Deferred() bool     { return true }
func (t *journalReadTool) ParallelSafe() bool { return true }

func (t *journalReadTool) Description() string {
	return "Reads one journal event by its seq from journal_search, with its full payload (long payloads are cut)."
}

func (t *journalReadTool) ParameterSchema() string {
	return schema(map[string]any{"seq": prop("integer", "The event's seq.")}, "seq")
}

func (t *journalReadTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t.deps.Audience.IsZero() || strings.TrimSpace(t.deps.JournalDir) == "" {
		return "", noAudience()
	}
	seq := int64(intParam(params, "seq"))
	if seq <= 0 {
		return "", errors.New("seq is required")
	}
	record, err := domainjournal.ReadAtDir(t.deps.JournalDir, domainjournal.RecordRef{Seq: seq})
	if err != nil || !canHearEvent(t.deps.Audience, record.Event) {
		// An event the audience may not hear reads as missing, so its existence does not leak.
		return "", fmt.Errorf("no journal event %d here", seq)
	}
	payload := string(record.Event.Payload)
	truncated := false
	if len(payload) > maxJournalReadSize {
		payload, truncated = excerptBytes(payload, maxJournalReadSize), true
	}
	return result(map[string]any{
		"seq": seq, "id": record.Event.ID, "time": record.Event.Time, "domain": record.Event.Domain, "type": record.Event.Type,
		"task_id": record.Event.Trace.TaskID, "payload": payload, "truncated": truncated,
	})
}

func excerpt(text string, maxRunes int) string {
	if utf8.RuneCountInString(text) <= maxRunes {
		return text
	}
	return string([]rune(text)[:maxRunes]) + "…"
}

func excerptBytes(text string, max int) string {
	text = text[:max]
	for len(text) > 0 && !utf8.ValidString(text) {
		text = text[:len(text)-1]
	}
	return text
}
