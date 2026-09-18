package chatcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/llm"
)

func handleInitRead(writer io.Writer, agentsPath string) bool {
	if _, err := os.Stat(agentsPath); err == nil {
		data, err := os.ReadFile(agentsPath)
		if err != nil {
			_, _ = fmt.Fprintf(writer, "Error reading AGENTS.md: %v\n", err)
		} else {
			_, _ = fmt.Fprintln(writer, "\n--- AGENTS.md ---")
			_, _ = fmt.Fprintln(writer, string(data))
			_, _ = fmt.Fprintln(writer, "-----------------")
		}
		return true
	}
	return false
}

func handleAgentsGenerate(
	parent context.Context,
	writer io.Writer,
	input string,
	projectDir string,
	timeout time.Duration,
	engine *agent.Engine,
	model string,
	history []llm.Message,
) ([]llm.Message, bool) {
	agentsPath := filepath.Join(projectDir, "AGENTS.md")
	isUpdate := strings.ToLower(input) == "/update"
	if isUpdate {
		_, _ = fmt.Fprintln(writer, "\033[33m⚙️  Regenerating AGENTS.md...\033[0m")
	}
	initCtx, initCancel := chatTimeoutContext(parent, timeout)
	initCtx = pathroots.WithWorkspaceDir(initCtx, projectDir)
	initPrompt := chatcommands.ProjectGuidePrompt(projectDir)
	final, _, err := engine.Run(initCtx, initPrompt, agent.RunOptions{
		Model:   strings.TrimSpace(model),
		Scene:   "chat.init",
		History: append([]llm.Message(nil), history...),
	})
	initCancel()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			_, _ = fmt.Fprintln(writer, "\n\033[33m⚡ Interrupted.\033[0m")
			return history, false
		}
		_, _ = fmt.Fprintf(writer, "Error generating AGENTS.md: %v\n", err)
		return history, false
	}
	content := formatChatOutput(final)
	if content == "" {
		_, _ = fmt.Fprintln(writer, "AI returned empty content. AGENTS.md not created.")
		return history, false
	}
	content = chatcommands.StripMarkdownFences(content)
	if err := os.WriteFile(agentsPath, []byte(content), 0o644); err != nil {
		_, _ = fmt.Fprintf(writer, "Error writing AGENTS.md: %v\n", err)
		return history, false
	}
	if isUpdate {
		_, _ = fmt.Fprintf(writer, "\033[32m✓ AGENTS.md updated at %s\033[0m\n", agentsPath)
	} else {
		_, _ = fmt.Fprintf(writer, "\033[32m✓ AGENTS.md created at %s\033[0m\n", agentsPath)
	}
	_, _ = fmt.Fprintln(writer, "\n--- AGENTS.md ---")
	_, _ = fmt.Fprintln(writer, content)
	_, _ = fmt.Fprintln(writer, "-----------------")
	history = append(history, llm.Message{Role: "user", Content: fmt.Sprintf("I have initialized this project. Here is the AGENTS.md for this project:\n\n%s", content)})
	history = append(history, llm.Message{Role: "assistant", Content: "Got it. I've read the AGENTS.md and understand this project's structure, conventions, and guidelines. I'm ready to help."})
	return history, true
}
