package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

const (
	contactsListDefaultLimit = 50
	contactsListMaxLimit     = 200
)

// ContactsListTool lists the agent's contacts from agent.db, filtered by status, kind and channel.
// It replaces reading contacts/ACTIVE.md and INACTIVE.md with read_file.
type ContactsListTool struct {
	stateDir    string
	contactsDir string
}

// NewContactsListTool returns the tool for the contacts whose folder is contactsDir, kept in the
// agent.db of stateDir (the folder above contactsDir when stateDir is empty).
func NewContactsListTool(stateDir, contactsDir string) *ContactsListTool {
	return &ContactsListTool{
		stateDir:    pathutil.ExpandHomePath(strings.TrimSpace(stateDir)),
		contactsDir: pathutil.ExpandHomePath(strings.TrimSpace(contactsDir)),
	}
}

func (t *ContactsListTool) Name() string { return "contacts_list" }

func (t *ContactsListTool) Description() string {
	return `Lists your contacts: people and agents you can reach, with their contact_id, nickname, kind, channel, status and channel identifiers.
		Filter by status (active, the default; inactive; or all), kind (human or agent) and channel (telegram, slack, agentlink, ...).
		Use a contact's contact_id to reference or message it.`
}

func (t *ContactsListTool) ParameterSchema() string {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"status": map[string]any{
				"type":        "string",
				"enum":        []string{"active", "inactive", "all"},
				"description": "Which contacts to list. Defaults to active.",
			},
			"kind": map[string]any{
				"type":        "string",
				"enum":        []string{"human", "agent"},
				"description": "Only people (human) or only agents (agent).",
			},
			"channel": map[string]any{
				"type":        "string",
				"description": "Only contacts on this channel, for example telegram, slack or agentlink.",
			},
			"limit": map[string]any{
				"type":        "integer",
				"description": fmt.Sprintf("Most contacts to return (default %d, at most %d).", contactsListDefaultLimit, contactsListMaxLimit),
			},
		},
		"additionalProperties": false,
	}
	raw, _ := json.Marshal(schema)
	return string(raw)
}

func (t *ContactsListTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.contactsDir == "" {
		return "", fmt.Errorf("contacts_list is not configured")
	}
	text := func(key string) string {
		value, _ := params[key].(string)
		return strings.ToLower(strings.TrimSpace(value))
	}
	filter := contacts.ContactFilter{Kind: contacts.Kind(text("kind")), Channel: text("channel")}
	switch status := text("status"); status {
	case "", "active":
		filter.Status = contacts.StatusActive
	case "inactive":
		filter.Status = contacts.StatusInactive
	case "all":
	default:
		return "", fmt.Errorf("status must be active, inactive or all")
	}
	if filter.Kind != "" && filter.Kind != contacts.KindHuman && filter.Kind != contacts.KindAgent {
		return "", fmt.Errorf("kind must be human or agent")
	}
	limit := contactsListDefaultLimit
	switch v := params["limit"].(type) {
	case float64:
		limit = int(v)
	case int:
		limit = v
	case int64:
		limit = int(v)
	}
	if limit <= 0 {
		limit = contactsListDefaultLimit
	}
	limit = min(limit, contactsListMaxLimit)
	items, err := contacts.NewStoreInStateDir(t.stateDir, t.contactsDir).ListContactsFiltered(ctx, filter)
	if err != nil {
		return "", err
	}
	total := len(items)
	if len(items) > limit {
		items = items[:limit]
	}
	out, err := json.Marshal(map[string]any{
		"count":     len(items),
		"total":     total,
		"truncated": total > len(items),
		"contacts":  items,
	})
	if err != nil {
		return "", err
	}
	return string(out), nil
}
