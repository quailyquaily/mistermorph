package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

type localSubtaskRunner struct {
	engine *Engine
}

func (r *localSubtaskRunner) RunSubtask(ctx context.Context, req SubtaskRequest) (*SubtaskResult, error) {
	if r == nil || r.engine == nil {
		return nil, fmt.Errorf("subtask runner is unavailable")
	}
	if err := ValidateSubtaskStart(ctx); err != nil {
		return FailedSubtaskResult("", err), nil
	}
	target, err := r.subtaskTarget(ctx, req)
	if err != nil {
		return FailedSubtaskResult("", err), nil
	}
	if target.Close != nil {
		defer target.Close()
	}

	taskID, runCtx, meta := PrepareSubtaskContext(ctx, req.Meta)
	log := r.engine.log
	EmitEvent(ctx, nil, Event{
		Kind:       EventKindSubtaskStart,
		ActivityID: taskID,
		TaskID:     taskID,
		Mode:       localSubtaskMode(req),
		Profile:    string(NormalizeObserveProfile(string(req.ObserveProfile))),
		Status:     "running",
		Text:       req.Task,
		Model:      target.Model,
	})
	if log != nil {
		log.Info("subtask_start", "task_id", taskID, "mode", localSubtaskMode(req), "output_schema", strings.TrimSpace(req.OutputSchema),
			"model_profile", strings.TrimSpace(req.ModelProfile), "model", target.Model)
	}

	var result *SubtaskResult
	if req.RunFunc != nil {
		directResult, err := req.RunFunc(runCtx)
		if err != nil {
			result = FailedSubtaskResult(taskID, err)
		} else {
			result = NormalizeDirectSubtaskResult(taskID, req.OutputSchema, directResult)
		}
	} else {
		result = r.runAgentSubtask(runCtx, meta, taskID, req, target)
	}

	if log != nil && result != nil {
		log.Info("subtask_done", "task_id", taskID, "status", result.Status, "output_kind", result.OutputKind)
	}
	if result != nil {
		EmitEventDetached(ctx, nil, Event{
			Kind:       EventKindSubtaskDone,
			ActivityID: taskID,
			TaskID:     taskID,
			Status:     strings.TrimSpace(result.Status),
			Summary:    strings.TrimSpace(result.Summary),
			OutputKind: strings.TrimSpace(result.OutputKind),
			Error:      strings.TrimSpace(result.Error),
		})
	}
	return result, nil
}

// subtaskTarget picks the client a subtask runs on: the parent's, or the selected profile's.
func (r *localSubtaskRunner) subtaskTarget(ctx context.Context, req SubtaskRequest) (SubtaskProfile, error) {
	profile := strings.TrimSpace(req.ModelProfile)
	if profile == "" {
		return SubtaskProfile{
			Client:                   r.engine.client,
			Model:                    strings.TrimSpace(r.engine.config.DefaultModel),
			SystemPromptCacheControl: r.engine.systemPromptCacheControl,
		}, nil
	}
	if r.engine.subtaskProfileResolver == nil {
		return SubtaskProfile{}, SubtaskProfileError(profile, fmt.Errorf("model profiles are not supported by this runtime"))
	}
	target, err := r.engine.subtaskProfileResolver(ctx, profile)
	if err != nil {
		return SubtaskProfile{}, SubtaskProfileError(profile, err)
	}
	if target.Client == nil {
		if target.Close != nil {
			target.Close()
		}
		return SubtaskProfile{}, SubtaskProfileError(profile, fmt.Errorf("no client for this profile"))
	}
	target.Model = strings.TrimSpace(target.Model)
	return target, nil
}

func (r *localSubtaskRunner) runAgentSubtask(ctx context.Context, meta map[string]any, taskID string, req SubtaskRequest, target SubtaskProfile) *SubtaskResult {
	subOpts := []Option{WithLogger(r.engine.log)}
	if r.engine.guard != nil {
		subOpts = append(subOpts, WithGuard(r.engine.guard))
	}
	if target.SystemPromptCacheControl != nil {
		subOpts = append(subOpts, WithSystemPromptCacheControl(target.SystemPromptCacheControl))
	}

	subEngine := New(target.Client, req.Registry, Config{
		MaxSteps:          r.engine.config.MaxSteps,
		MaxTokenBudget:    r.engine.config.MaxTokenBudget,
		ParseRetries:      r.engine.config.ParseRetries,
		ToolRepeatLimit:   r.engine.config.ToolRepeatLimit,
		DefaultModel:      target.Model,
		ToolCallTimeout:   r.engine.config.ToolCallTimeout,
		ContextCompaction: r.engine.config.ContextCompaction,
	}, r.engine.spec, append(subOpts, WithEngineToolsConfig(EngineToolsConfig{
		SpawnEnabled: false,
		CoderEnabled: false,
	}))...)

	final, _, err := subEngine.Run(ctx, BuildSubtaskTask(req.Task, req.OutputSchema), RunOptions{
		SessionID: taskID,
		Model:     target.Model,
		Scene:     "spawn.subtask",
		Meta:      meta,
	})
	if err != nil {
		return FailedSubtaskResult(taskID, err)
	}
	return SubtaskResultFromFinal(taskID, req.OutputSchema, final)
}

func PrepareSubtaskContext(ctx context.Context, meta map[string]any) (string, context.Context, map[string]any) {
	taskID := llmstats.NewSyntheticRunID("sub")
	runCtx := llmstats.WithRunID(ctx, taskID)
	runCtx = WithSubtaskDepth(runCtx, SubtaskDepthFromContext(runCtx)+1)

	outMeta := cloneSubtaskMeta(meta)
	outMeta["trigger"] = "subtask.spawn"
	outMeta["subtask_task_id"] = taskID
	if parentRunID := strings.TrimSpace(llmstats.RunIDFromContext(ctx)); parentRunID != "" {
		outMeta["subtask_parent_run_id"] = parentRunID
	}
	return taskID, runCtx, outMeta
}

func cloneSubtaskMeta(meta map[string]any) map[string]any {
	if len(meta) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(meta))
	for k, v := range meta {
		out[k] = v
	}
	return out
}

func localSubtaskMode(req SubtaskRequest) string {
	if req.RunFunc != nil {
		return "direct"
	}
	return "agent"
}

func NormalizeDirectSubtaskResult(taskID string, outputSchema string, result *SubtaskResult) *SubtaskResult {
	if result == nil {
		return FailedSubtaskResult(taskID, fmt.Errorf("subtask returned nil result"))
	}
	out := *result
	if strings.TrimSpace(out.TaskID) == "" {
		out.TaskID = strings.TrimSpace(taskID)
	}
	if strings.TrimSpace(out.Status) == "" {
		out.Status = SubtaskStatusDone
	}
	if strings.TrimSpace(out.OutputKind) == "" {
		switch out.Output.(type) {
		case string:
			out.OutputKind = SubtaskOutputKindText
		default:
			out.OutputKind = SubtaskOutputKindJSON
		}
	}
	if strings.TrimSpace(out.OutputSchema) == "" && strings.TrimSpace(outputSchema) != "" && out.OutputKind == SubtaskOutputKindJSON {
		out.OutputSchema = strings.TrimSpace(outputSchema)
	}
	if strings.TrimSpace(out.Summary) == "" {
		if out.Status == SubtaskStatusFailed {
			out.Summary = "subtask failed"
		} else if out.OutputKind == SubtaskOutputKindJSON {
			out.Summary = "subtask completed with structured output"
		} else if s, ok := out.Output.(string); ok {
			out.Summary = summarizeSubtaskText(s)
		}
		if strings.TrimSpace(out.Summary) == "" && out.Status != SubtaskStatusFailed {
			out.Summary = "subtask completed"
		}
	}
	return &out
}
