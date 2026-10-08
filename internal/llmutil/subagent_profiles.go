package llmutil

import (
	"fmt"
	"sort"
	"strings"
)

// Profile abilities, set with llm.abilities and llm.profiles.<name>.abilities.
const (
	// AbilityText is text chat with tool calls: the profile can run an agent loop.
	AbilityText = "text"
	// AbilityImage is image generation and editing.
	AbilityImage = "image"
	// AbilityDecision is Evaluate requests.
	AbilityDecision = "decision"
)

// NormalizeAbilities trims, lowercases and deduplicates a profile's abilities, keeping their
// order. An empty result means the profile has every ability. An unknown value is an error.
func NormalizeAbilities(raw []string) ([]string, error) {
	var out []string
	seen := make(map[string]bool, len(raw))
	for _, value := range raw {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		switch value {
		case AbilityText, AbilityImage, AbilityDecision:
		default:
			return nil, fmt.Errorf("unknown ability %q (use %s, %s or %s)", value, AbilityText, AbilityImage, AbilityDecision)
		}
		seen[value] = true
		out = append(out, value)
	}
	return out, nil
}

// HasAbility reports whether normalized abilities include ability. Empty abilities include all.
func HasAbility(abilities []string, ability string) bool {
	if len(abilities) == 0 {
		return true
	}
	for _, value := range abilities {
		if value == ability {
			return true
		}
	}
	return false
}

// SubagentProfile is a profile a subtask can run on, as list_model_profiles shows it. Err is
// set, and Model and Description are empty, when the profile failed to resolve.
type SubagentProfile struct {
	Name        string
	Model       string
	Description string
	Err         error
}

// CheckSubagentProfile returns an error when a resolved profile cannot run a subtask: its
// abilities leave out text, or its provider supports only Evaluate.
func CheckSubagentProfile(profile ResolvedProfile) error {
	if !HasAbility(profile.Values.Abilities, AbilityText) {
		return fmt.Errorf("profile %q does not have the text ability (abilities: %s)", profile.Name, strings.Join(profile.Values.Abilities, ", "))
	}
	if strings.EqualFold(strings.TrimSpace(profile.ClientConfig.Provider), "typesafe") {
		return fmt.Errorf("profile %q uses typesafe, which supports only Evaluate, not agent chat", profile.Name)
	}
	return nil
}

// ListSubagentProfiles lists the profiles a subtask can run on: default first, then the named
// profiles by name. Profiles that cannot run a subtask are left out. A profile that fails to
// resolve is listed with its error, so the caller can pick another one. The error return is only
// for config that cannot be read as a whole.
func ListSubagentProfiles(values RuntimeValues) ([]SubagentProfile, error) {
	if values.Routes.ParseErr != nil {
		return nil, values.Routes.ParseErr
	}
	names := make([]string, 0, len(values.Profiles))
	for name := range values.Profiles {
		name = strings.TrimSpace(name)
		if name == "" || name == RouteProfileDefault {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	names = append([]string{RouteProfileDefault}, names...)

	out := make([]SubagentProfile, 0, len(names))
	for _, name := range names {
		profile, err := ResolveProfile(values, name)
		if err != nil {
			if !unresolvedProfileMayRunSubagent(values, name) {
				continue
			}
			out = append(out, SubagentProfile{Name: name, Err: err})
			continue
		}
		if CheckSubagentProfile(profile) != nil {
			continue
		}
		out = append(out, SubagentProfile{
			Name:        name,
			Model:       strings.TrimSpace(profile.ClientConfig.Model),
			Description: strings.TrimSpace(profile.Values.Description),
		})
	}
	return out, nil
}

// unresolvedProfileMayRunSubagent decides, from a profile's raw config, whether a profile that
// failed to resolve should still be listed with its error. A profile whose config already rules
// it out is left out, as it would be when it resolves.
func unresolvedProfileMayRunSubagent(values RuntimeValues, name string) bool {
	raw, err := resolveProfileValues(values, name)
	if err != nil {
		return true
	}
	if abilities, err := NormalizeAbilities(raw.Abilities); err == nil && !HasAbility(abilities, AbilityText) {
		return false
	}
	for _, provider := range []string{raw.Provider, raw.InferenceProvider} {
		if strings.EqualFold(strings.TrimSpace(provider), "typesafe") {
			return false
		}
	}
	return true
}

// ResolveSubagentRoute resolves the route a subtask runs on when it selects a profile by name:
// the profile's own config, with the main_loop route's fallback profiles.
func ResolveSubagentRoute(values RuntimeValues, profileName string) (ResolvedRoute, error) {
	profile, err := ResolveProfile(values, profileName)
	if err != nil {
		return ResolvedRoute{}, err
	}
	if err := CheckSubagentProfile(profile); err != nil {
		return ResolvedRoute{}, err
	}
	return ResolveRouteWithProfileOverride(values, RoutePurposeMainLoop, profile.Name)
}

func profileConfigKey(profileName, field string) string {
	profileName = strings.TrimSpace(profileName)
	if profileName == "" || profileName == RouteProfileDefault {
		return "llm." + field
	}
	return "llm.profiles." + profileName + "." + field
}
