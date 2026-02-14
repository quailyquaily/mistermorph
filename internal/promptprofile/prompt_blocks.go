package promptprofile

import (
	_ "embed"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"text/template"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/prompttmpl"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	localToolNotesDefaultMaxBytes   = 8 * 1024
	planCreatePromptBlockTitle      = "Plan Create Guidance"
	localToolNotesPromptBlockTitle  = "Local Tool Notes"
	memorySummariesPromptBlockTitle = "Memory Summaries"
	groupUsernamesPromptBlockTitle  = "Group Usernames"
	TelegramRuntimePromptBlockTitle = "Telegram Policies"
	MAEPReplyPromptBlockTitle       = "MAEP Policies"
)

//go:embed prompts/block_plan_create.tmpl
var planCreateBlockTemplateSource string

//go:embed prompts/telegram_block.tmpl
var telegramRuntimePromptBlockTemplateSource string

//go:embed prompts/maep_block.tmpl
var maepReplyPromptBlockSource string

var telegramRuntimePromptBlockTemplate = prompttmpl.MustParse(
	"telegram_runtime_block",
	telegramRuntimePromptBlockTemplateSource,
	template.FuncMap{},
)

type telegramRuntimePromptBlockData struct {
	IsGroup bool
}

func AppendPlanCreateGuidanceBlock(spec *agent.PromptSpec, registry *tools.Registry) {
	if spec == nil || registry == nil {
		return
	}
	if _, ok := registry.Get("plan_create"); !ok {
		return
	}
	content := strings.TrimSpace(planCreateBlockTemplateSource)
	if content == "" {
		return
	}
	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title:   planCreatePromptBlockTitle,
		Content: content,
	})
}

func AppendLocalToolNotesBlock(spec *agent.PromptSpec, log *slog.Logger) {
	if spec == nil {
		return
	}
	if log == nil {
		log = slog.Default()
	}

	path := filepath.Join(statepaths.FileStateDir(), "TOOLS.md")
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("prompt_local_tool_notes_load_failed", "path", path, "error", err.Error())
		}
		return
	}

	content := strings.TrimSpace(string(raw))
	if content == "" {
		log.Debug("prompt_local_tool_notes_skipped", "path", path, "reason", "empty")
		return
	}

	content, truncated := truncateUTF8Bytes(content, localToolNotesDefaultMaxBytes)
	if content == "" {
		log.Debug("prompt_local_tool_notes_skipped", "path", path, "reason", "empty_after_truncate")
		return
	}

	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title:   localToolNotesPromptBlockTitle,
		Content: content,
	})
	log.Info("prompt_local_tool_notes_applied", "path", path, "size", len(content), "max_bytes", localToolNotesDefaultMaxBytes, "truncated", truncated)
}

func AppendMemorySummariesBlock(spec *agent.PromptSpec, content string) {
	if spec == nil {
		return
	}
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}
	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title:   memorySummariesPromptBlockTitle,
		Content: content,
	})
}

func AppendTelegramRuntimeBlocks(spec *agent.PromptSpec, isGroup bool, mentionUsers []string) {
	if spec == nil {
		return
	}
	content, err := prompttmpl.Render(telegramRuntimePromptBlockTemplate, telegramRuntimePromptBlockData{
		IsGroup: isGroup,
	})
	if err == nil {
		content = strings.TrimSpace(content)
		if content != "" {
			spec.Blocks = append(spec.Blocks, agent.PromptBlock{
				Title:   TelegramRuntimePromptBlockTitle,
				Content: content,
			})
		}
	}

	if !isGroup {
		return
	}
	if len(mentionUsers) > 0 {
		spec.Blocks = append(spec.Blocks, agent.PromptBlock{
			Title:   groupUsernamesPromptBlockTitle,
			Content: strings.Join(mentionUsers, "\n"),
		})
	}
}

func AppendMAEPReplyPolicyBlock(spec *agent.PromptSpec) {
	if spec == nil {
		return
	}
	content := strings.TrimSpace(maepReplyPromptBlockSource)
	if content == "" {
		return
	}
	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title:   MAEPReplyPromptBlockTitle,
		Content: content,
	})
}

func truncateUTF8Bytes(input string, maxBytes int) (string, bool) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", false
	}
	if maxBytes <= 0 {
		return "", len(input) > 0
	}

	raw := []byte(input)
	if len(raw) <= maxBytes {
		return input, false
	}

	clipped := raw[:maxBytes]
	for len(clipped) > 0 && !utf8.Valid(clipped) {
		clipped = clipped[:len(clipped)-1]
	}
	return strings.TrimSpace(string(clipped)), true
}
