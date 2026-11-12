package builtin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"unicode"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	refid "github.com/quailyquaily/mistermorph/internal/entryutil/refid"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/llm"
)

type TodoUpdateTool struct {
	Enabled  bool
	CronPath string
	Contacts string
	// StateDir is the state folder whose agent.db keeps the contacts; empty, the folder above
	// Contacts.
	StateDir   string
	Client     llm.Client
	Model      string
	AddContext todo.AddResolveContext
	// DecisionClient, when set, matches a delete request to a task on the decision route.
	DecisionClient llm.Client
	DecisionModel  string
}

var todoUpdateEnglishSpeakerWordPattern = regexp.MustCompile(`(?i)\b(i|me|my|myself)\b`)

func NewTodoUpdateTool(enabled bool, cronPath string, contactsDir string) *TodoUpdateTool {
	return NewTodoUpdateToolWithLLM(enabled, cronPath, contactsDir, nil, "")
}

func NewTodoUpdateToolWithLLM(enabled bool, cronPath string, contactsDir string, client llm.Client, model string) *TodoUpdateTool {
	return &TodoUpdateTool{
		Enabled:  enabled,
		CronPath: strings.TrimSpace(cronPath),
		Contacts: strings.TrimSpace(contactsDir),
		Client:   client,
		Model:    strings.TrimSpace(model),
	}
}

func (t *TodoUpdateTool) BindLLM(client llm.Client, model string) {
	if t == nil {
		return
	}
	t.Client = client
	t.Model = strings.TrimSpace(model)
}

func (t *TodoUpdateTool) Clone() *TodoUpdateTool {
	if t == nil {
		return nil
	}
	cp := *t
	cp.AddContext.MentionUsernames = append([]string(nil), t.AddContext.MentionUsernames...)
	return &cp
}

func (t *TodoUpdateTool) SetAddContext(ctx todo.AddResolveContext) {
	if t == nil {
		return
	}
	ctx.Channel = strings.ToLower(strings.TrimSpace(ctx.Channel))
	ctx.ChatType = strings.ToLower(strings.TrimSpace(ctx.ChatType))
	ctx.SpeakerUsername = strings.TrimPrefix(strings.TrimSpace(ctx.SpeakerUsername), "@")
	ctx.MentionUsernames = normalizeTodoUpdateUsernames(ctx.MentionUsernames)
	ctx.UserInputRaw = strings.TrimSpace(ctx.UserInputRaw)
	t.AddContext = ctx
}

func (t *TodoUpdateTool) Name() string { return "todo_update" }

func (t *TodoUpdateTool) Description() string {
	return "Updates the TODO list (scheduled agent tasks). Supports add_once, add_recurring, update, and delete actions. " +
		"To change an existing task (its content, schedule, title, or bash_env), use update with the task id: " +
		"it changes only the fields you pass and keeps everything else. Never delete and re-add a task to edit it."
}

func (t *TodoUpdateTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type": "string",
				"enum": []string{"add_once", "add_recurring", "update", "delete"},
				"description": "Action: add_once|add_recurring|update|delete. " +
					"update edits an existing task by id in place: pass only the fields to change; every omitted field " +
					"(including bash_env, workspace_dir, schedule, tz, chat_id and title) keeps its current value, and the id stays the same. " +
					"Do not delete and re-add a task to edit it.",
			},
			"content": map[string]any{
				"type": "string",
				"description": "Task content. Required for add_once, add_recurring, and delete without id. " +
					"For update, the new content, stored exactly as given (people references are not resolved; keep existing `[Name](ref)` references as they are).",
			},
			"title": map[string]any{
				"type":        "string",
				"description": "Optional short task title. When omitted on add, a default title is used. For update, \"\" resets it to the default title.",
			},
			"at": map[string]any{
				"type": "string",
				"description": "One-time schedule for add_once, in YYYY-MM-DD HH:mm. " +
					"For update, setting at alone makes the task one-time and clears its cron.",
			},
			"cron": map[string]any{
				"type": "string",
				"description": "Five-field numeric cron expression for add_recurring. " +
					"For update, setting cron alone makes the task recurring and clears its at.",
			},
			"tz": map[string]any{
				"type":        "string",
				"description": "Optional IANA timezone or UTC offset, for example Asia/Tokyo or UTC+8. Omit to use runtime local timezone. For update, \"\" clears it.",
			},
			"id": map[string]any{
				"type":        "string",
				"description": "Stable task id. Required for update and for precise delete; optional on add, generated when omitted.",
			},
			"bash_env": map[string]any{
				"type": "array",
				"description": "Optional environment variables injected into the bash tool when the task runs, as [{\"name\": \"REPORT_MODE\", \"value\": \"weekly\"}]. " +
					"Values may reference environment variables as ${NAME}; prefer that over literal secrets. " +
					"For update, the list replaces the task's whole bash_env, [] clears it, and omitting bash_env keeps it unchanged. " +
					"Values are never shown in tool results.",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name":  map[string]any{"type": "string", "description": "Variable name: letters, digits and underscores, not starting with a digit."},
						"value": map[string]any{"type": "string", "description": "Variable value."},
					},
					"required":             []string{"name", "value"},
					"additionalProperties": false,
				},
			},
			"people": map[string]any{
				"type": "array",
				"description": "List of people mentioned in the content (required for add_once and add_recurring). " +
					"If the speaker mentions themselves (said `I` or `me`), resolve as '$SPEAKER' in the array." +
					"If the speaker mentions `you`, resolve as '$AGENT' in the array. " +
					"For others, put their nickname or an ID in the array.",
				"items": map[string]any{
					"type": "string",
				},
			},
			"workspace_dir": map[string]any{
				"type":        "string",
				"description": "Optional workspace directory for the task's runs (absolute path or ~/...). Pass `workspace_dir` to use the workspace attached to the current conversation. Omit to use the runtime default workspace. For update, \"\" clears it back to the runtime default.",
			},
			"chat_id": map[string]any{
				"type":        "string",
				"description": "Optional task notification chat id (for example tg:-1001234567890). Defaults to " + cronstore.ConsoleNotificationChatID + " in Console runtime on add. For update, \"\" clears it; there is no default.",
			},
		},
		"required": []string{"action"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *TodoUpdateTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.Enabled {
		return "", fmt.Errorf("todo_update tool is disabled")
	}
	action, _ := params["action"].(string)
	action = strings.ToLower(strings.TrimSpace(action))
	content, _ := params["content"].(string)
	content = strings.TrimSpace(content)
	if action == "" {
		return "", fmt.Errorf("action is required")
	}
	cronPath := pathutil.ExpandHomePath(strings.TrimSpace(t.CronPath))
	contactsDir := pathutil.ExpandHomePath(strings.TrimSpace(t.Contacts))
	if cronPath == "" {
		return "", fmt.Errorf("cron path is not configured")
	}
	if contactsDir == "" {
		return "", fmt.Errorf("contacts dir is not configured")
	}

	store := cronstore.NewStore(cronPath)
	var (
		result any
		err    error
	)
	switch action {
	case "add_once":
		if content == "" {
			return "", fmt.Errorf("content is required")
		}
		if t.Client == nil {
			return "", fmt.Errorf("todo_update unavailable (missing llm client)")
		}
		if strings.TrimSpace(t.Model) == "" {
			return "", fmt.Errorf("todo_update unavailable (missing llm model)")
		}
		chatID, chatIDErr := parseTodoUpdateChatID(params, t.AddContext)
		if chatIDErr != nil {
			return "", chatIDErr
		}
		at, atErr := parseTodoUpdateString(params, "at")
		if atErr != nil {
			return "", atErr
		}
		tz, tzErr := parseTodoUpdateOptionalString(params, "tz")
		if tzErr != nil {
			return "", tzErr
		}
		id, idErr := parseTodoUpdateOptionalString(params, "id")
		if idErr != nil {
			return "", idErr
		}
		title, titleErr := parseTodoUpdateOptionalString(params, "title")
		if titleErr != nil {
			return "", titleErr
		}
		people, peopleErr := parseTodoUpdatePeopleOptional(params)
		if peopleErr != nil {
			return "", peopleErr
		}
		workspaceDir, workspaceErr := parseTodoUpdateWorkspaceDir(ctx, params)
		if workspaceErr != nil {
			return "", workspaceErr
		}
		bashEnv, bashEnvErr := parseTodoUpdateBashEnvOptional(params)
		if bashEnvErr != nil {
			return "", bashEnvErr
		}
		slog.Default().Debug("todo_update_add_start",
			"content_len", len(content),
			"chat_id", chatID,
			"people_count", len(people),
			"bash_env_count", len(bashEnv),
			"context_channel", t.AddContext.Channel,
			"context_chat_type", t.AddContext.ChatType,
			"context_chat_id", t.AddContext.ChatID,
			"context_speaker_user_id", t.AddContext.SpeakerUserID,
			"context_speaker_username", t.AddContext.SpeakerUsername,
			"context_mentions_count", len(t.AddContext.MentionUsernames),
			"context_user_input_raw_len", len(t.AddContext.UserInputRaw),
		)
		rewritten, warnings, resolveErr := t.resolveAddContent(ctx, content, people, contactsDir, true)
		if resolveErr != nil {
			return "", resolveErr
		}
		addResult, addErr := store.AddOnce(cronstore.Task{Title: title, Content: rewritten, At: at, TZ: tz, ID: id, ChatID: chatID, WorkspaceDir: workspaceDir, BashEnv: bashEnv})
		addResult.Warnings = append(addResult.Warnings, warnings...)
		result, err = todoUpdateAddOutput(addResult), addErr
	case "add_recurring":
		if content == "" {
			return "", fmt.Errorf("content is required")
		}
		if t.Client == nil {
			return "", fmt.Errorf("todo_update unavailable (missing llm client)")
		}
		if strings.TrimSpace(t.Model) == "" {
			return "", fmt.Errorf("todo_update unavailable (missing llm model)")
		}
		chatID, chatIDErr := parseTodoUpdateChatID(params, t.AddContext)
		if chatIDErr != nil {
			return "", chatIDErr
		}
		cronExpr, cronErr := parseTodoUpdateString(params, "cron")
		if cronErr != nil {
			return "", cronErr
		}
		tz, tzErr := parseTodoUpdateOptionalString(params, "tz")
		if tzErr != nil {
			return "", tzErr
		}
		id, idErr := parseTodoUpdateOptionalString(params, "id")
		if idErr != nil {
			return "", idErr
		}
		title, titleErr := parseTodoUpdateOptionalString(params, "title")
		if titleErr != nil {
			return "", titleErr
		}
		people, peopleErr := parseTodoUpdatePeopleOptional(params)
		if peopleErr != nil {
			return "", peopleErr
		}
		workspaceDir, workspaceErr := parseTodoUpdateWorkspaceDir(ctx, params)
		if workspaceErr != nil {
			return "", workspaceErr
		}
		bashEnv, bashEnvErr := parseTodoUpdateBashEnvOptional(params)
		if bashEnvErr != nil {
			return "", bashEnvErr
		}
		rewritten, warnings, resolveErr := t.resolveAddContent(ctx, content, people, contactsDir, false)
		if resolveErr != nil {
			return "", resolveErr
		}
		addResult, addErr := store.AddRecurring(cronstore.Task{Title: title, Content: rewritten, Cron: cronExpr, TZ: tz, ID: id, ChatID: chatID, WorkspaceDir: workspaceDir, BashEnv: bashEnv})
		addResult.Warnings = append(addResult.Warnings, warnings...)
		result, err = todoUpdateAddOutput(addResult), addErr
	case "update":
		id, idErr := parseTodoUpdateString(params, "id")
		if idErr != nil {
			return "", fmt.Errorf("update needs the id of the task to change: %w", idErr)
		}
		patch, patchErr := parseTodoUpdatePatch(ctx, params)
		if patchErr != nil {
			return "", patchErr
		}
		updateResult, updateErr := store.Update(ctx, id, patch)
		if updateErr != nil {
			return "", updateErr
		}
		slog.Default().Debug("todo_update_update", "id", id, "fields", strings.Join(updateResult.Fields, ","))
		result = todoUpdateOutput{
			OK:        updateResult.OK,
			Action:    updateResult.Action,
			TaskCount: updateResult.TaskCount,
			Task:      redactTodoUpdateTask(updateResult.Task),
			Fields:    updateResult.Fields,
		}
	case "delete":
		id, idErr := parseTodoUpdateOptionalString(params, "id")
		if idErr != nil {
			return "", idErr
		}
		if strings.TrimSpace(id) == "" {
			if content == "" {
				return "", fmt.Errorf("id or content is required")
			}
			if t.Client == nil {
				return "", fmt.Errorf("todo_update unavailable (missing llm client)")
			}
			if strings.TrimSpace(t.Model) == "" {
				return "", fmt.Errorf("todo_update unavailable (missing llm model)")
			}
			resolver := cronstore.NewLLMSemanticResolver(t.Client, t.Model)
			resolver.Decision = t.DecisionClient
			resolver.DecisionModel = strings.TrimSpace(t.DecisionModel)
			store.Semantics = resolver
		}
		deleteResult, deleteErr := store.Delete(ctx, id, content)
		result, err = todoUpdateOutput{
			OK:        deleteResult.OK,
			Action:    deleteResult.Action,
			TaskCount: deleteResult.TaskCount,
			Deleted:   redactTodoUpdateTask(deleteResult.Deleted),
		}, deleteErr
	default:
		return "", fmt.Errorf("invalid action: %s", action)
	}
	if err != nil {
		return "", err
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return string(out), nil
}

func (t *TodoUpdateTool) resolveAddContent(ctx context.Context, content string, people []string, contactsDir string, enforceRequiredReferences bool) (string, []string, error) {
	if _, preErr := todo.ExtractReferenceIDs(content); preErr != nil {
		return "", nil, preErr
	}
	rewritten := content
	var warnings []string
	var builtinErr error
	rewritten, people, warnings, builtinErr = t.resolveBuiltinPeople(rewritten, people, warnings)
	if builtinErr != nil {
		return "", nil, builtinErr
	}
	if len(people) == 0 {
		return t.resolveAddPlaceholders(content, rewritten, warnings)
	}
	snapshot, snapErr := todo.LoadContactSnapshot(ctx, t.StateDir, contactsDir)
	if snapErr != nil {
		return "", nil, snapErr
	}
	resolver := todo.NewLLMReferenceResolver(t.Client, t.Model)
	rewritten, warnings, resolveErr := resolver.ResolveAddContent(ctx, rewritten, people, snapshot, t.AddContext)
	fallbackRawWrite := false
	if resolveErr != nil {
		var missingErr *todo.MissingReferenceIDError
		if errors.As(resolveErr, &missingErr) {
			fallbackRawWrite = true
			rewritten = content
			warnings = appendIfMissingWarning(warnings, "reference_unresolved_write_raw")
			slog.Default().Debug("todo_update_add_reference_unresolved_fallback",
				"missing_count", len(missingErr.Items),
			)
		} else {
			return "", nil, resolveErr
		}
	}
	slog.Default().Debug("todo_update_add_resolved",
		"rewritten", rewritten,
		"warnings_count", len(warnings),
		"fallback_raw_write", fallbackRawWrite,
	)
	if enforceRequiredReferences && !fallbackRawWrite {
		if requiredErr := todo.ValidateRequiredReferenceMentions(rewritten, snapshot); requiredErr != nil {
			var missingErr *todo.MissingReferenceIDError
			if errors.As(requiredErr, &missingErr) {
				firstMention := ""
				firstSuggestion := ""
				firstReason := ""
				if len(missingErr.Items) > 0 {
					firstMention = strings.TrimSpace(missingErr.Items[0].Mention)
					firstSuggestion = strings.TrimSpace(missingErr.Items[0].Suggestion)
					firstReason = strings.TrimSpace(missingErr.Items[0].Reason)
				}
				slog.Default().Debug("todo_update_add_required_reference_fallback_detail",
					"rewritten_before_fallback", rewritten,
					"fallback_target_content", content,
					"first_missing_mention", firstMention,
					"first_missing_suggestion", firstSuggestion,
					"first_missing_reason", firstReason,
				)
				rewritten = content
				warnings = appendIfMissingWarning(warnings, "reference_unresolved_write_raw")
				slog.Default().Debug("todo_update_add_required_reference_fallback",
					"missing_count", len(missingErr.Items),
				)
			} else {
				return "", nil, requiredErr
			}
		}
	}
	rewritten, warnings, placeholderErr := t.resolveAddPlaceholders(content, rewritten, warnings)
	if placeholderErr != nil {
		return "", nil, placeholderErr
	}
	return rewritten, warnings, nil
}

func (t *TodoUpdateTool) resolveBuiltinPeople(content string, people []string, warnings []string) (string, []string, []string, error) {
	if len(people) == 0 {
		return content, nil, warnings, nil
	}
	remaining := make([]string, 0, len(people))
	speakerRequested := false
	for _, raw := range people {
		value := strings.TrimSpace(raw)
		switch {
		case todoUpdateIsSpeakerPlaceholder(value):
			speakerRequested = true
		case strings.EqualFold(value, "$AGENT"):
			continue
		default:
			remaining = append(remaining, value)
		}
	}
	if !speakerRequested {
		return content, remaining, warnings, nil
	}
	rewritten, err := t.resolveSpeakerBuiltinContent(content)
	if err != nil {
		return "", nil, nil, err
	}
	return rewritten, remaining, warnings, nil
}

func (t *TodoUpdateTool) resolveSpeakerBuiltinContent(content string) (string, error) {
	speakerRef := todoUpdateSpeakerReferenceID(t.AddContext)
	if speakerRef == "" {
		return content, nil
	}
	label := todoUpdateSpeakerReferenceLabel(content)
	formatted, err := refid.FormatMarkdownReference(label, speakerRef)
	if err != nil {
		return "", err
	}
	if strings.Contains(content, "$SPEAKER") || strings.Contains(content, "$USER") {
		content = strings.ReplaceAll(content, "$SPEAKER", formatted)
		content = strings.ReplaceAll(content, "$USER", formatted)
		return content, nil
	}
	if replaced, ok := todoUpdateReplaceFirstSpeakerWord(content, formatted); ok {
		return replaced, nil
	}
	return content, nil
}

func (t *TodoUpdateTool) resolveAddPlaceholders(original string, rewritten string, warnings []string) (string, []string, error) {
	rewritten = strings.TrimSpace(rewritten)
	if rewritten == "" {
		return "", nil, fmt.Errorf("content is required")
	}
	if strings.Contains(rewritten, "$SPEAKER") || strings.Contains(rewritten, "$USER") {
		speakerRef := todoUpdateSpeakerReferenceID(t.AddContext)
		if speakerRef != "" {
			label := todoUpdateSpeakerReferenceLabel(rewritten)
			formatted, err := refid.FormatMarkdownReference(label, speakerRef)
			if err != nil {
				return "", nil, err
			}
			rewritten = strings.ReplaceAll(rewritten, "$SPEAKER", formatted)
			rewritten = strings.ReplaceAll(rewritten, "$USER", formatted)
		}
	}
	if containsTodoUpdateReferencePlaceholder(rewritten) {
		original = strings.TrimSpace(original)
		if containsTodoUpdateReferencePlaceholder(original) {
			return "", nil, fmt.Errorf("unresolved reference placeholder in content")
		}
		warnings = appendIfMissingWarning(warnings, "reference_placeholder_unresolved_write_raw")
		return original, warnings, nil
	}
	return rewritten, warnings, nil
}

func todoUpdateSpeakerReferenceID(ctx todo.AddResolveContext) string {
	if ref, ok := refid.Normalize(ctx.SpeakerUsername); ok {
		return ref
	}
	switch strings.ToLower(strings.TrimSpace(ctx.Channel)) {
	case "console":
		return "console:user"
	case "telegram":
		if ctx.SpeakerUserID != 0 {
			return fmt.Sprintf("tg:%d", ctx.SpeakerUserID)
		}
		username := strings.TrimPrefix(strings.TrimSpace(ctx.SpeakerUsername), "@")
		if username != "" {
			return "tg:@" + username
		}
	}
	return ""
}

func todoUpdateSpeakerReferenceLabel(content string) string {
	for _, r := range content {
		if unicode.In(r, unicode.Han) {
			return "我"
		}
	}
	return "me"
}

func containsTodoUpdateReferencePlaceholder(content string) bool {
	return strings.Contains(content, "$SPEAKER") || strings.Contains(content, "$USER") || strings.Contains(content, "$AGENT")
}

func todoUpdateIsSpeakerPlaceholder(value string) bool {
	return strings.EqualFold(value, "$SPEAKER") || strings.EqualFold(value, "$USER")
}

func todoUpdateReplaceFirstSpeakerWord(content string, formatted string) (string, bool) {
	for _, token := range []string{"本人", "我"} {
		if idx := strings.Index(content, token); idx >= 0 {
			return content[:idx] + formatted + content[idx+len(token):], true
		}
	}
	if loc := todoUpdateEnglishSpeakerWordPattern.FindStringIndex(content); loc != nil {
		return content[:loc[0]] + formatted + content[loc[1]:], true
	}
	return content, false
}

func normalizeTodoUpdateUsernames(input []string) []string {
	if len(input) == 0 {
		return nil
	}
	out := make([]string, 0, len(input))
	seen := make(map[string]bool, len(input))
	for _, raw := range input {
		v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "@"))
		if v == "" {
			continue
		}
		key := strings.ToLower(v)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, v)
	}
	return out
}

func parseTodoUpdatePeopleOptional(params map[string]any) ([]string, error) {
	raw, exists := params["people"]
	if !exists || raw == nil {
		return nil, nil
	}
	return parseTodoUpdatePeopleValue(raw)
}

func parseTodoUpdatePeopleValue(raw any) ([]string, error) {
	switch v := raw.(type) {
	case []string:
		return normalizeTodoUpdateUsernames(v), nil
	case []any:
		items := make([]string, 0, len(v))
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("people must be an array of strings")
			}
			items = append(items, s)
		}
		return normalizeTodoUpdateUsernames(items), nil
	default:
		return nil, fmt.Errorf("people must be an array of strings")
	}
}

func parseTodoUpdateString(params map[string]any, names ...string) (string, error) {
	value, err := parseTodoUpdateOptionalString(params, names...)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", fmt.Errorf("%s is required", strings.TrimSpace(names[0]))
	}
	return value, nil
}

func parseTodoUpdateOptionalString(params map[string]any, names ...string) (string, error) {
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		raw, exists := params[name]
		if !exists || raw == nil {
			continue
		}
		value, ok := raw.(string)
		if !ok {
			return "", fmt.Errorf("%s must be a string", name)
		}
		return strings.TrimSpace(value), nil
	}
	return "", nil
}

// parseTodoUpdateWorkspaceDir returns the task's workspace directory, or "" when none is
// given. The `workspace_dir` alias names the workspace attached to the current run.
func parseTodoUpdateWorkspaceDir(ctx context.Context, params map[string]any) (string, error) {
	raw, err := parseTodoUpdateOptionalString(params, "workspace_dir")
	if err != nil || raw == "" {
		return "", err
	}
	return resolveTodoUpdateWorkspaceDir(ctx, raw)
}

func resolveTodoUpdateWorkspaceDir(ctx context.Context, raw string) (string, error) {
	if strings.EqualFold(raw, "workspace_dir") {
		current, ok := pathroots.WorkspaceDirFromContext(ctx)
		if !ok {
			return "", fmt.Errorf("workspace_dir: no workspace is attached to the current conversation")
		}
		raw = current
	}
	resolved, err := workspace.ValidateDir(raw, nil)
	if err != nil {
		return "", fmt.Errorf("workspace_dir: %w", err)
	}
	return resolved, nil
}

func parseTodoUpdateChatID(params map[string]any, addContext todo.AddResolveContext) (string, error) {
	if raw, exists := params["chat_id"]; exists && raw != nil {
		value, ok := raw.(string)
		if !ok {
			return "", fmt.Errorf("chat_id must be a string")
		}
		if value = strings.TrimSpace(value); value != "" {
			return value, nil
		}
	}
	if strings.EqualFold(strings.TrimSpace(addContext.Channel), "console") {
		return cronstore.ConsoleNotificationChatID, nil
	}
	return "", nil
}

func appendIfMissingWarning(warnings []string, v string) []string {
	v = strings.TrimSpace(v)
	if v == "" {
		return warnings
	}
	for _, item := range warnings {
		if strings.TrimSpace(item) == v {
			return warnings
		}
	}
	return append(warnings, v)
}
