package personastore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
)

// Workflow is one thing the heartbeat checks: a title and Markdown instructions, which can be
// switched off without deleting them.
type Workflow struct {
	ID           string `json:"id"`
	Position     int    `json:"position"`
	Title        string `json:"title"`
	Instructions string `json:"instructions"`
	Enabled      bool   `json:"enabled"`
	CreatedAt    string `json:"created_at,omitempty"`
	UpdatedAt    string `json:"updated_at,omitempty"`
}

// ErrWorkflowNotFound is returned for a workflow id with no row.
var ErrWorkflowNotFound = errors.New("heartbeat workflow not found")

// DefaultWorkflowTitle names a workflow made from checklist text outside any "## " section.
const DefaultWorkflowTitle = "Checklist"

// checklistTitle is the heading HEARTBEAT.md opens with.
const checklistTitle = "# Heartbeat Checklist"

// templatePurpose is the template's line under its heading, which is not a workflow.
const templatePurpose = "*THE PURPOSE OF THIS FILE IS TO LIST WORKFLOWS TO BE CHECKED DURING REGULAR HEARTBEAT*"

// offPrefix marks a switched-off workflow's heading in the rendered checklist.
const offPrefix = "[off] "

func newWorkflowID() string {
	return "hb-" + uuid.NewString()
}

// Workflows lists the workflows in order.
func (s *Store) Workflows(ctx context.Context) ([]Workflow, error) {
	return listWorkflows(ctx, s.db)
}

type rowsQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func listWorkflows(ctx context.Context, q rowsQueryer) ([]Workflow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, position, title, instructions, enabled, created_at, updated_at
		FROM heartbeat_workflows ORDER BY position, created_at, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Workflow{}
	for rows.Next() {
		var w Workflow
		var enabled int
		if err := rows.Scan(&w.ID, &w.Position, &w.Title, &w.Instructions, &enabled, &w.CreatedAt, &w.UpdatedAt); err != nil {
			return nil, err
		}
		w.Enabled = enabled != 0
		out = append(out, w)
	}
	return out, rows.Err()
}

// ReplaceWorkflows makes the list exactly items, in their order, in one transaction. An item whose
// id names a workflow keeps that row (and its created_at); an item without one gets a new id.
func (s *Store) ReplaceWorkflows(ctx context.Context, items []Workflow) ([]Workflow, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := replaceWorkflows(ctx, tx, items); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Workflows(ctx)
}

func replaceWorkflows(ctx context.Context, tx *sql.Tx, items []Workflow) error {
	existing, err := listWorkflows(ctx, tx)
	if err != nil {
		return err
	}
	created := map[string]string{}
	for _, w := range existing {
		created[w.ID] = w.CreatedAt
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM heartbeat_workflows`); err != nil {
		return err
	}
	now := agentdb.Now()
	seen := map[string]bool{}
	for i, item := range items {
		item, err := normalizeWorkflow(item)
		if err != nil {
			return fmt.Errorf("workflow %d: %w", i+1, err)
		}
		if item.ID == "" || seen[item.ID] {
			item.ID = newWorkflowID()
		}
		seen[item.ID] = true
		createdAt := created[item.ID]
		if createdAt == "" {
			createdAt = now
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO heartbeat_workflows (id, position, title, instructions, enabled, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, item.ID, i, item.Title, item.Instructions, agentdb.Bool(item.Enabled), createdAt, now); err != nil {
			return err
		}
	}
	return nil
}

func normalizeWorkflow(w Workflow) (Workflow, error) {
	w.ID = strings.TrimSpace(w.ID)
	w.Title = strings.TrimSpace(w.Title)
	w.Instructions = strings.TrimSpace(strings.ReplaceAll(w.Instructions, "\r\n", "\n"))
	if w.Title == "" {
		return w, fmt.Errorf("title is required")
	}
	if strings.ContainsAny(w.Title, "\n\r") {
		return w, fmt.Errorf("title must be one line")
	}
	return w, nil
}

// AddWorkflow appends a workflow, or puts it at position when position is in range.
func (s *Store) AddWorkflow(ctx context.Context, w Workflow, position int) (Workflow, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Workflow{}, err
	}
	defer func() { _ = tx.Rollback() }()
	items, err := listWorkflows(ctx, tx)
	if err != nil {
		return Workflow{}, err
	}
	w.ID = newWorkflowID()
	if position < 0 || position > len(items) {
		position = len(items)
	}
	items = append(items[:position], append([]Workflow{w}, items[position:]...)...)
	if err := replaceWorkflows(ctx, tx, items); err != nil {
		return Workflow{}, err
	}
	if err := tx.Commit(); err != nil {
		return Workflow{}, err
	}
	return s.Workflow(ctx, w.ID)
}

// Workflow returns one workflow.
func (s *Store) Workflow(ctx context.Context, id string) (Workflow, error) {
	items, err := s.Workflows(ctx)
	if err != nil {
		return Workflow{}, err
	}
	for _, w := range items {
		if w.ID == strings.TrimSpace(id) {
			return w, nil
		}
	}
	return Workflow{}, ErrWorkflowNotFound
}

// WorkflowPatch changes some fields of a workflow; nil fields stay. Position moves it.
type WorkflowPatch struct {
	Title        *string `json:"title,omitempty"`
	Instructions *string `json:"instructions,omitempty"`
	Enabled      *bool   `json:"enabled,omitempty"`
	Position     *int    `json:"position,omitempty"`
}

// UpdateWorkflow applies patch to the workflow id, in one transaction.
func (s *Store) UpdateWorkflow(ctx context.Context, id string, patch WorkflowPatch) (Workflow, error) {
	id = strings.TrimSpace(id)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Workflow{}, err
	}
	defer func() { _ = tx.Rollback() }()
	items, err := listWorkflows(ctx, tx)
	if err != nil {
		return Workflow{}, err
	}
	index := -1
	for i, w := range items {
		if w.ID == id {
			index = i
		}
	}
	if index < 0 {
		return Workflow{}, ErrWorkflowNotFound
	}
	w := items[index]
	if patch.Title != nil {
		w.Title = *patch.Title
	}
	if patch.Instructions != nil {
		w.Instructions = *patch.Instructions
	}
	if patch.Enabled != nil {
		w.Enabled = *patch.Enabled
	}
	items = append(items[:index], items[index+1:]...)
	position := index
	if patch.Position != nil {
		position = min(max(*patch.Position, 0), len(items))
	}
	items = append(items[:position], append([]Workflow{w}, items[position:]...)...)
	if err := replaceWorkflows(ctx, tx, items); err != nil {
		return Workflow{}, err
	}
	if err := tx.Commit(); err != nil {
		return Workflow{}, err
	}
	return s.Workflow(ctx, id)
}

// DeleteWorkflow removes the workflow id.
func (s *Store) DeleteWorkflow(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM heartbeat_workflows WHERE id = ?`, strings.TrimSpace(id))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrWorkflowNotFound
	}
	return nil
}

// HeartbeatTask renders the enabled workflows as the heartbeat's task: each as "## <title>"
// followed by its instructions, in order. It reports empty when no enabled workflow has
// instructions, so there is no heartbeat task, as an empty checklist had none.
func HeartbeatTask(items []Workflow) (string, bool) {
	var parts []string
	hasSteps := false
	for _, w := range items {
		if !w.Enabled {
			continue
		}
		section := "## " + strings.TrimSpace(w.Title)
		if steps := strings.TrimSpace(w.Instructions); steps != "" {
			section += "\n\n" + steps
			hasSteps = true
		}
		parts = append(parts, section)
	}
	if !hasSteps {
		return "", true
	}
	return strings.Join(parts, "\n\n"), false
}

// HeartbeatTask reads the workflows and renders the heartbeat's task.
func (s *Store) HeartbeatTask(ctx context.Context) (string, bool, error) {
	items, err := s.Workflows(ctx)
	if err != nil {
		return "", true, err
	}
	text, empty := HeartbeatTask(items)
	return text, empty, nil
}

// RenderChecklist writes the workflows as HEARTBEAT.md: a title, then each workflow as a "## "
// section. A switched-off workflow's heading starts with "[off] ", which ParseChecklist reads back.
func RenderChecklist(items []Workflow) string {
	var b strings.Builder
	b.WriteString(checklistTitle)
	b.WriteString("\n")
	for _, w := range items {
		b.WriteString("\n## ")
		if !w.Enabled {
			b.WriteString(offPrefix)
		}
		b.WriteString(strings.TrimSpace(w.Title))
		b.WriteString("\n")
		if steps := strings.TrimSpace(w.Instructions); steps != "" {
			b.WriteString("\n")
			b.WriteString(steps)
			b.WriteString("\n")
		}
	}
	return b.String()
}

var htmlComment = regexp.MustCompile(`(?s)<!--.*?-->`)

// ParseChecklist reads HEARTBEAT.md into workflows: one per "## " section, after HTML comments
// are removed. Text outside any section becomes a workflow titled "Checklist"; headings there
// (the file's "# Heartbeat Checklist") and the template's purpose line are not workflows. The
// template, whose example is a comment, gives none.
func ParseChecklist(raw string) []Workflow {
	content := htmlComment.ReplaceAllString(strings.ReplaceAll(raw, "\r\n", "\n"), "")
	type section struct {
		title string
		lines []string
	}
	var preamble []string
	var sections []section
	current := -1
	fenced := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fenced = !fenced
		}
		if !fenced && strings.HasPrefix(line, "## ") {
			sections = append(sections, section{title: strings.TrimSpace(strings.TrimPrefix(line, "## "))})
			current = len(sections) - 1
			continue
		}
		if current < 0 {
			if !fenced && (strings.HasPrefix(trimmed, "#") || trimmed == templatePurpose) {
				continue
			}
			preamble = append(preamble, line)
			continue
		}
		sections[current].lines = append(sections[current].lines, line)
	}
	var out []Workflow
	if text := strings.TrimSpace(strings.Join(preamble, "\n")); text != "" {
		out = append(out, Workflow{Title: DefaultWorkflowTitle, Instructions: text, Enabled: true})
	}
	for _, sec := range sections {
		title := sec.title
		enabled := true
		if strings.HasPrefix(title, offPrefix) {
			title = strings.TrimSpace(strings.TrimPrefix(title, offPrefix))
			enabled = false
		}
		if title == "" {
			title = DefaultWorkflowTitle
		}
		out = append(out, Workflow{Title: title, Instructions: strings.TrimSpace(strings.Join(sec.lines, "\n")), Enabled: enabled})
	}
	return out
}

// MatchWorkflowIDs gives parsed workflows the ids of existing ones with the same title, in order,
// so saving a checklist text keeps the rows it did not change.
func MatchWorkflowIDs(parsed, existing []Workflow) []Workflow {
	used := map[string]bool{}
	for i := range parsed {
		for _, w := range existing {
			if !used[w.ID] && strings.EqualFold(w.Title, parsed[i].Title) {
				parsed[i].ID = w.ID
				used[w.ID] = true
				break
			}
		}
	}
	return parsed
}
