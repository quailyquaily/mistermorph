package telegramcmd

import (
	_ "embed"
	"encoding/json"
	"text/template"

	"github.com/quailyquaily/mistermorph/internal/prompttmpl"
	"github.com/quailyquaily/mistermorph/memory"
)

//go:embed prompts/memory_draft_system.tmpl
var memoryDraftSystemPromptTemplateSource string

//go:embed prompts/memory_draft_user.tmpl
var memoryDraftUserPromptTemplateSource string

//go:embed prompts/memory_merge_system.tmpl
var memoryMergeSystemPromptTemplateSource string

//go:embed prompts/memory_merge_user.tmpl
var memoryMergeUserPromptTemplateSource string

//go:embed prompts/memory_task_match_system.tmpl
var memoryTaskMatchSystemPromptTemplateSource string

//go:embed prompts/memory_task_match_user.tmpl
var memoryTaskMatchUserPromptTemplateSource string

//go:embed prompts/memory_task_dedup_system.tmpl
var memoryTaskDedupSystemPromptTemplateSource string

//go:embed prompts/memory_task_dedup_user.tmpl
var memoryTaskDedupUserPromptTemplateSource string

var memoryPromptTemplateFuncs = template.FuncMap{
	"toJSON": func(v any) (string, error) {
		b, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		return string(b), nil
	},
}

var memoryDraftSystemPromptTemplate = prompttmpl.MustParse("telegram_memory_draft_system", memoryDraftSystemPromptTemplateSource, nil)
var memoryDraftUserPromptTemplate = prompttmpl.MustParse("telegram_memory_draft_user", memoryDraftUserPromptTemplateSource, memoryPromptTemplateFuncs)
var memoryMergeSystemPromptTemplate = prompttmpl.MustParse("telegram_memory_merge_system", memoryMergeSystemPromptTemplateSource, nil)
var memoryMergeUserPromptTemplate = prompttmpl.MustParse("telegram_memory_merge_user", memoryMergeUserPromptTemplateSource, memoryPromptTemplateFuncs)
var memoryTaskMatchSystemPromptTemplate = prompttmpl.MustParse("telegram_memory_task_match_system", memoryTaskMatchSystemPromptTemplateSource, nil)
var memoryTaskMatchUserPromptTemplate = prompttmpl.MustParse("telegram_memory_task_match_user", memoryTaskMatchUserPromptTemplateSource, memoryPromptTemplateFuncs)
var memoryTaskDedupSystemPromptTemplate = prompttmpl.MustParse("telegram_memory_task_dedup_system", memoryTaskDedupSystemPromptTemplateSource, nil)
var memoryTaskDedupUserPromptTemplate = prompttmpl.MustParse("telegram_memory_task_dedup_user", memoryTaskDedupUserPromptTemplateSource, memoryPromptTemplateFuncs)

type memoryDraftUserPromptData struct {
	SessionContext    MemoryDraftContext
	Conversation      []map[string]string
	ExistingTasks     []memory.TaskItem
	ExistingFollowUps []memory.TaskItem
}

func renderMemoryDraftPrompts(
	ctxInfo MemoryDraftContext,
	conversation []map[string]string,
	existingTasks []memory.TaskItem,
	existingFollowUps []memory.TaskItem,
) (string, string, error) {
	systemPrompt, err := prompttmpl.Render(memoryDraftSystemPromptTemplate, struct{}{})
	if err != nil {
		return "", "", err
	}
	userPrompt, err := prompttmpl.Render(memoryDraftUserPromptTemplate, memoryDraftUserPromptData{
		SessionContext:    ctxInfo,
		Conversation:      conversation,
		ExistingTasks:     existingTasks,
		ExistingFollowUps: existingFollowUps,
	})
	if err != nil {
		return "", "", err
	}
	return systemPrompt, userPrompt, nil
}

type memoryMergeUserPromptData struct {
	Existing semanticMergeContent
	Incoming semanticMergeContent
}

func renderMemoryMergePrompts(existing semanticMergeContent, incoming semanticMergeContent) (string, string, error) {
	systemPrompt, err := prompttmpl.Render(memoryMergeSystemPromptTemplate, struct{}{})
	if err != nil {
		return "", "", err
	}
	userPrompt, err := prompttmpl.Render(memoryMergeUserPromptTemplate, memoryMergeUserPromptData{
		Existing: existing,
		Incoming: incoming,
	})
	if err != nil {
		return "", "", err
	}
	return systemPrompt, userPrompt, nil
}

type memoryTaskMatchUserPromptData struct {
	Existing []memory.TaskItem
	Updates  []memory.TaskItem
}

func renderMemoryTaskMatchPrompts(existing []memory.TaskItem, updates []memory.TaskItem) (string, string, error) {
	systemPrompt, err := prompttmpl.Render(memoryTaskMatchSystemPromptTemplate, struct{}{})
	if err != nil {
		return "", "", err
	}
	userPrompt, err := prompttmpl.Render(memoryTaskMatchUserPromptTemplate, memoryTaskMatchUserPromptData{
		Existing: existing,
		Updates:  updates,
	})
	if err != nil {
		return "", "", err
	}
	return systemPrompt, userPrompt, nil
}

type memoryTaskDedupUserPromptData struct {
	Tasks []memory.TaskItem
}

func renderMemoryTaskDedupPrompts(tasks []memory.TaskItem) (string, string, error) {
	systemPrompt, err := prompttmpl.Render(memoryTaskDedupSystemPromptTemplate, struct{}{})
	if err != nil {
		return "", "", err
	}
	userPrompt, err := prompttmpl.Render(memoryTaskDedupUserPromptTemplate, memoryTaskDedupUserPromptData{
		Tasks: tasks,
	})
	if err != nil {
		return "", "", err
	}
	return systemPrompt, userPrompt, nil
}
