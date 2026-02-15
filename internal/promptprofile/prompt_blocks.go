package promptprofile

import (
	_ "embed"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"text/template"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/prompttmpl"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	planCreatePromptBlockTitle      = "Plan Create Guidance"
	localToolNotesPromptBlockTitle  = "Local Scripts"
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
		content = "No local tool notes available."
	}

	content = "* The following are notes about the local scripts. Please read them carefully before using any local scripts.\n" +
		"* You can use python or bash to create new script to satisfy specific needs.\n" +
		"* Always put your scripts at `file_state_dir/`, and update the SCRIPTS.md in following format:" +
		"```" + "\n" +
		`- name: "get_weather"` + "\n" +
		"  script: `file_state_dir/scripts/get_weather.sh`" + "\n" +
		`  description: "Get the weather for a specified location."` + "\n" +
		`  usage: "file_state_dir/scripts/get_weather.sh <location>"` + "\n" +
		"```\n" +
		">>> BEGIN OF SCRIPTS.md <<<\n" +
		"\n" + content + "\n" +
		">>> END OF SCRIPTS.md <<<"

	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title:   localToolNotesPromptBlockTitle,
		Content: content,
	})
	log.Info("prompt_local_tool_notes_applied", "path", path, "size", len(content))
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
