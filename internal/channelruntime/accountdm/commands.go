package accountdm

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

// handleCommand runs a shared chat command and returns its reply; handled is false for text that
// is not a command (or /ctx compact, which runs as a task).
func handleCommand(ctx context.Context, d Dependencies, store *workspace.Store, conversationKey string, in Inbound, channel string, currentSkills []string, reset func(context.Context) error) (reply string, handled bool) {
	registry := chatcommands.NewRuntimeRegistry(chatcommands.RuntimeRegistryOptions{
		ModelCommand:        d.HandleModelCommand,
		SkillCommand:        skillCommand(d.HandleSkillCommand, currentSkills),
		ContextCommand:      topiccontext.NewStore(d.RuntimePaths.TopicContextPath).CommandFunc(conversationKey),
		WorkspaceStore:      store,
		WorkspaceKey:        conversationKey,
		DefaultWorkspaceDir: d.DefaultWorkspaceDir,
	})
	registry.Register("/id", "show this chat's and your IDs", func(context.Context, string) (*chatcommands.Result, error) {
		return &chatcommands.Result{Reply: fmt.Sprintf("chat_id=%s:%s user=%s_user:%s account=%s", channel, in.PeerID, channel, in.PeerID, in.AccountID)}, nil
	})
	registry.Register("/reset", "clear conversation history and sticky skills", func(commandCtx context.Context, _ string) (*chatcommands.Result, error) {
		if err := reset(commandCtx); err != nil {
			return nil, err
		}
		return &chatcommands.Result{Reply: "ok (reset)"}, nil
	})
	result, handled, err := registry.Dispatch(ctx, in.Text)
	if !handled {
		return "", false
	}
	if result != nil && result.Action == chatcommands.ActionContextCompact {
		return "", false
	}
	if err != nil {
		return "error: " + strings.TrimSpace(err.Error()), true
	}
	if result != nil {
		return strings.TrimSpace(result.Reply), true
	}
	return "", true
}

func skillCommand(fn HandleSkillCommandFunc, currentSkills []string) chatcommands.SkillCommandFunc {
	if fn == nil {
		return nil
	}
	snapshot := append([]string(nil), currentSkills...)
	return func() (string, error) { return fn(snapshot) }
}

func commandName(text string) string {
	command, _ := chatcommands.ParseCommand(text)
	return chatcommands.NormalizeCommand(command)
}
