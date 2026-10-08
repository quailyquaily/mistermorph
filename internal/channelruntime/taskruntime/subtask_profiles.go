package taskruntime

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
)

// resolveSubtaskProfileRoute resolves the route of a model profile a spawn subtask selected.
func resolveSubtaskProfileRoute(d depsutil.CommonDependencies, profile string) (llmutil.ResolvedRoute, error) {
	if d.LLMValues == nil {
		return llmutil.ResolvedRoute{}, fmt.Errorf("model profiles are not supported by this runtime")
	}
	values, err := d.LLMValues()
	if err != nil {
		return llmutil.ResolvedRoute{}, err
	}
	return llmutil.ResolveSubagentRoute(values, profile)
}

// ModelProfileLister lists the profiles a spawn subtask can select, for list_model_profiles, with
// currentProfile marked as the one the parent runs on. It returns nil, and the tool is left out,
// when there is at most one profile to choose from.
func ModelProfileLister(d depsutil.CommonDependencies, currentProfile string) agent.ModelProfileLister {
	if d.LLMValues == nil {
		return nil
	}
	values, err := d.LLMValues()
	var profiles []llmutil.SubagentProfile
	if err == nil {
		profiles, err = llmutil.ListSubagentProfiles(values)
	}
	if err != nil {
		return func(context.Context) ([]agent.ModelProfile, error) { return nil, err }
	}
	if len(profiles) < 2 {
		return nil
	}
	currentProfile = strings.TrimSpace(currentProfile)
	if currentProfile == "" {
		currentProfile = llmutil.RouteProfileDefault
	}
	out := make([]agent.ModelProfile, 0, len(profiles))
	for _, profile := range profiles {
		entry := agent.ModelProfile{
			Name:        profile.Name,
			Model:       profile.Model,
			Description: profile.Description,
			Current:     profile.Name == currentProfile,
		}
		if profile.Err != nil {
			entry.Error = profile.Err.Error()
		}
		out = append(out, entry)
	}
	return func(context.Context) ([]agent.ModelProfile, error) { return out, nil }
}

// SubtaskProfileResolver gives an engine that runs subtasks itself (no task runtime runner) the
// client of a model profile a spawn subtask selects. It returns nil when d cannot resolve profiles.
func SubtaskProfileResolver(d depsutil.CommonDependencies) agent.SubtaskProfileResolver {
	if d.LLMValues == nil || d.CreateLLMClient == nil {
		return nil
	}
	return func(_ context.Context, profile string) (agent.SubtaskProfile, error) {
		route, err := resolveSubtaskProfileRoute(d, profile)
		if err != nil {
			return agent.SubtaskProfile{}, err
		}
		cacheControl, err := llmutil.SystemPromptCacheControl(route.Values.CacheTTL)
		if err != nil {
			return agent.SubtaskProfile{}, err
		}
		client, err := d.CreateLLMClient(route)
		if err != nil {
			return agent.SubtaskProfile{}, err
		}
		target := agent.SubtaskProfile{
			Client:                   client,
			Model:                    strings.TrimSpace(route.ClientConfig.Model),
			SystemPromptCacheControl: cacheControl,
		}
		if closer, ok := client.(io.Closer); ok {
			target.Close = func() { _ = closer.Close() }
		}
		return target, nil
	}
}
