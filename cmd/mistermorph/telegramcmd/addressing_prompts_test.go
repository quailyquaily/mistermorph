package telegramcmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/spf13/viper"
)

func TestRenderTelegramAddressingPrompts(t *testing.T) {
	stateDir := t.TempDir()
	prevStateDir := viper.GetString("file_state_dir")
	viper.Set("file_state_dir", stateDir)
	t.Cleanup(func() {
		viper.Set("file_state_dir", prevStateDir)
	})
	soul := "---\nstatus: done\n---\n\n# SOUL.md\n\n## Boundaries\n- Keep it concise.\n"
	if err := os.WriteFile(filepath.Join(stateDir, "SOUL.md"), []byte(soul), 0o644); err != nil {
		t.Fatalf("write SOUL.md: %v", err)
	}

	historyPayload := chathistory.BuildContextPayload(chathistory.ChannelTelegram, []chathistory.ChatHistoryItem{
		{
			Kind: chathistory.KindInboundUser,
			Text: "hello from [Alice](tg:@alice)",
		},
	})
	sys, user, err := renderTelegramAddressingPrompts("my_bot", []string{"mybot", "morph"}, "hey mybot do this", historyPayload)
	if err != nil {
		t.Fatalf("renderTelegramAddressingPrompts() error = %v", err)
	}
	if !strings.Contains(sys, "handled by me according following rules") {
		t.Fatalf("unexpected system prompt: %q", sys)
	}
	if !strings.Contains(sys, "## Boundaries") {
		t.Fatalf("system prompt should include SOUL content: %q", sys)
	}

	var payload struct {
		BotUsername        string `json:"bot_username"`
		CurrentMessage     string `json:"current_message"`
		ChatHistoryContext struct {
			Type string `json:"type"`
		} `json:"chat_history_context"`
		Aliases []string `json:"aliases"`
	}
	if err := json.Unmarshal([]byte(user), &payload); err != nil {
		t.Fatalf("user prompt is not valid json: %v", err)
	}
	if payload.BotUsername != "my_bot" {
		t.Fatalf("bot_username = %q, want my_bot", payload.BotUsername)
	}
	if len(payload.Aliases) != 2 {
		t.Fatalf("aliases len = %d, want 2", len(payload.Aliases))
	}
	if strings.TrimSpace(payload.CurrentMessage) == "" {
		t.Fatalf("current_message should not be empty")
	}
	if payload.ChatHistoryContext.Type != chathistory.ContextType {
		t.Fatalf("chat_history_context.type = %q, want %q", payload.ChatHistoryContext.Type, chathistory.ContextType)
	}
}
