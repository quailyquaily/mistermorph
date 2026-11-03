package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/clipperhouse/uax29/v2/graphemes"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

type consoleMessageReactTool struct {
	store           *daemonruntime.ConsoleFileStore
	hub             *consoleStreamHub
	taskID          string
	topicID         string
	conversationKey string
}

func newConsoleMessageReactTool(store *daemonruntime.ConsoleFileStore, hub *consoleStreamHub, job consoleLocalTaskJob) *consoleMessageReactTool {
	return &consoleMessageReactTool{store: store, hub: hub, taskID: job.TaskID, topicID: job.TopicID, conversationKey: job.ConversationKey}
}

func (t *consoleMessageReactTool) Name() string { return "message_react" }

func (t *consoleMessageReactTool) Description() string {
	return "Attaches one emoji reaction to the user message that started this Console task. Does not send a reply. Repeating the same emoji is idempotent; a different emoji replaces the previous reaction."
}

func (t *consoleMessageReactTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"emoji": map[string]any{
				"type":        "string",
				"description": "One Unicode emoji to attach to the originating user message.",
			},
		},
		"required": []string{"emoji"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *consoleMessageReactTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.store == nil {
		return "", fmt.Errorf("message_react: originating target is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	for key := range params {
		if key != "emoji" {
			return "", fmt.Errorf("message_react: unsupported param %q; only the originating message can be targeted", key)
		}
	}
	emoji, _ := params["emoji"].(string)
	emoji = strings.TrimSpace(emoji)
	if emoji == "" {
		return "", fmt.Errorf("missing required param: emoji")
	}
	// A flag, skin tone or ZWJ sequence is one visible emoji, not several badges.
	clusters := graphemes.FromString(emoji)
	symbol := strings.ContainsFunc(emoji, func(r rune) bool {
		return unicode.IsSymbol(r) || r == '\u20e3' || r == '\u203c' || r == '\u2049' || r == '\u3030' || r == '\u303d'
	})
	if !utf8.ValidString(emoji) || !clusters.Next() || clusters.Next() || !symbol {
		return "", fmt.Errorf("message_react: emoji must be a single Unicode emoji")
	}
	if t.topicID == "" || t.conversationKey != buildConsoleConversationKey(t.topicID) {
		return "", fmt.Errorf("message_react: unauthorized originating target conversation")
	}
	if err := t.store.SetUserReaction(t.taskID, t.topicID, t.conversationKey, emoji); err != nil {
		return "", err
	}
	t.hub.publish(consoleStreamFrame{TaskID: t.taskID, UserReaction: emoji})
	return fmt.Sprintf("applied reaction %s to originating user message %s", emoji, t.taskID), nil
}
