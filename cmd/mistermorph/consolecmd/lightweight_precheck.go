package consolecmd

import (
	"context"
	"strings"

	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
)

// consoleLightweightPrecheckApplies reports whether a Console task is a plain chat message the
// decision route may answer with an emoji: typed in the Console, with no files, wake signal, or
// approval to resume.
func consoleLightweightPrecheckApplies(job consoleLocalTaskJob, task string) bool {
	return strings.TrimSpace(job.ResumeApprovalID) == "" &&
		job.WakeSignal.IsZero() &&
		consoleTriggerSource(job.Trigger) == "ui" &&
		runtimecore.LightweightPrecheckApplies(task, len(job.FileReferences) > 0)
}

// runConsoleLightweightPrecheck asks the decision route whether a chat message needs only an
// emoji. The Console has no reactions, so a chosen emoji becomes the task's output. It runs only
// when the decision route uses a different profile from the task's main route.
func (r *consoleLocalRuntime) runConsoleLightweightPrecheck(ctx context.Context, generation *consoleLocalRuntimeGeneration, job consoleLocalTaskJob, mainRoute llmutil.ResolvedRoute) (runtimecore.PrecheckResult, string) {
	if generation == nil || generation.bundle == nil || generation.bundle.taskRuntime == nil || generation.commonDeps.ResolveLLMRoute == nil {
		return runtimecore.PrecheckSkipped, ""
	}
	decisionRoute, err := generation.commonDeps.ResolveLLMRoute(llmutil.RoutePurposeDecision)
	if err != nil || decisionRoute.SameProfile(mainRoute) {
		return runtimecore.PrecheckSkipped, ""
	}
	client, err := generation.bundle.taskRuntime.CreateClientForRoute(decisionRoute)
	if err != nil {
		if generation.logger != nil {
			generation.logger.Warn("console_lightweight_precheck_client_failed", "error", err.Error())
		}
		return runtimecore.PrecheckSkipped, ""
	}
	defer closeConsoleObserverClient(generation.logger, client)
	return runtimecore.RunLightweightPrecheck(ctx, &runtimecore.ChannelRuntimeBundle{
		AddressingRoute:     decisionRoute,
		AddressingClient:    client,
		AddressingModel:     strings.TrimSpace(decisionRoute.ClientConfig.Model),
		LightweightPrecheck: true,
	}, runtimecore.LightweightPrecheckRequest{
		Scene:          "console.lightweight_decision",
		PersonaDir:     generation.paths.PersonaDir,
		CurrentMessage: map[string]any{"chat_type": "topic", "text": strings.TrimSpace(job.Task)},
		History:        chathistory.BuildMessages("console", r.loadConsoleTopicHistory(job)),
		Logger:         generation.logger,
		// The task returns the emoji as its output, so there is nothing to send here.
		Deliver: func(context.Context, string) error { return nil },
	})
}
