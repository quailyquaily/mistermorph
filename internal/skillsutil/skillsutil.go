package skillsutil

import (
	"context"
	"log/slog"
	"path"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/skills"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type SkillsConfig struct {
	Roots     []string
	Mode      string
	Requested []string
	Auto      bool
	MaxLoad   int
	Trace     bool
}

func SkillsConfigFromViper() SkillsConfig {
	cfg := SkillsConfig{
		Roots: statepaths.DefaultSkillsRoots(),
		Mode:  strings.TrimSpace(viper.GetString("skills.mode")),
		Auto:  skillsAutoFromViper(),
		Requested: append(
			append([]string{}, viper.GetStringSlice("skill")...), // legacy
			viper.GetStringSlice("skills")...,                    // legacy
		),
		MaxLoad: viper.GetInt("skills.max_load"),
		Trace:   strings.EqualFold(strings.TrimSpace(viper.GetString("logging.level")), "debug"),
	}
	cfg.Requested = append(cfg.Requested, getStringSlice("skills.load")...)
	if strings.TrimSpace(cfg.Mode) == "" {
		cfg.Mode = "on"
	}
	return cfg
}

func SkillsConfigFromRunCmd(cmd *cobra.Command) SkillsConfig {
	cfg := SkillsConfigFromViper()

	// Local flags override config/env.
	roots, _ := cmd.Flags().GetStringArray("skills-dir")
	if cmd.Flags().Changed("skills-dir") {
		cfg.Roots = roots
	}

	cfg.Mode = strings.TrimSpace(configutil.FlagOrViperString(cmd, "skills-mode", "skills.mode"))
	cfg.Auto = configutil.FlagOrViperBool(cmd, "skills-auto", "skills.auto")

	if cmd.Flags().Changed("skill") {
		cfg.Requested, _ = cmd.Flags().GetStringArray("skill")
	}

	cfg.MaxLoad = configutil.FlagOrViperInt(cmd, "skills-max-load", "skills.max_load")

	if strings.TrimSpace(cfg.Mode) == "" {
		cfg.Mode = "on"
	}

	return cfg
}

func PromptSpecWithSkills(ctx context.Context, log *slog.Logger, logOpts agent.LogOptions, task string, client llm.Client, model string, cfg SkillsConfig) (agent.PromptSpec, []string, []string, error) {
	if log == nil {
		log = slog.Default()
	}
	spec := agent.DefaultPromptSpec()
	var loadedOrdered []string
	declaredAuthProfiles := make(map[string]bool)

	discovered, err := skills.Discover(skills.DiscoverOptions{Roots: cfg.Roots})
	if err != nil {
		if cfg.Trace {
			log.Warn("skills_discover_warning", "error", err.Error())
		}
	}

	mode, modeReason := normalizeSkillsMode(cfg.Mode)
	if modeReason != "" {
		log.Info(
			"skills_mode_normalized",
			"requested_mode", strings.TrimSpace(cfg.Mode),
			"effective_mode", mode,
			"reason", modeReason,
		)
	}
	if mode == "off" {
		return spec, nil, nil, nil
	}

	loadedSkillIDs := make(map[string]bool)

	requested := append([]string{}, cfg.Requested...)

	if cfg.Auto {
		requested = append(requested, skills.ReferencedSkillNames(task)...)
	}

	uniq := make(map[string]bool, len(requested))
	var finalReq []string
	loadAll := false
	for _, r := range requested {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		if r == "*" {
			loadAll = true
		}
		k := strings.ToLower(r)
		if uniq[k] {
			continue
		}
		uniq[k] = true
		finalReq = append(finalReq, r)
	}
	if loadAll {
		finalReq = finalReq[:0]
		for _, s := range discovered {
			finalReq = append(finalReq, s.ID)
		}
		log.Info("skills_load_all_requested", "count", len(finalReq))
	}

	// On mode: strict load from configured/requested skills and optional $SkillName mentions.
	for _, q := range finalReq {
		s, err := skills.Resolve(discovered, q)
		if err != nil {
			return agent.PromptSpec{}, nil, nil, err
		}
		if loadedSkillIDs[strings.ToLower(s.ID)] {
			continue
		}
		skillLoaded, err := skills.LoadFrontmatter(s, 64*1024)
		if err != nil {
			return agent.PromptSpec{}, nil, nil, err
		}
		for _, ap := range skillLoaded.AuthProfiles {
			declaredAuthProfiles[ap] = true
		}
		loadedSkillIDs[strings.ToLower(skillLoaded.ID)] = true
		loadedOrdered = append(loadedOrdered, skillLoaded.ID)
		name := strings.TrimSpace(skillLoaded.Name)
		if name == "" {
			name = strings.TrimSpace(skillLoaded.ID)
		}
		desc := strings.TrimSpace(skillLoaded.Description)
		if desc == "" {
			desc = "(not provided)"
		}
		reqs := make([]string, 0, len(skillLoaded.Requirements))
		for _, req := range skillLoaded.Requirements {
			req = strings.TrimSpace(req)
			if req == "" {
				continue
			}
			reqs = append(reqs, req)
		}
		if len(reqs) == 0 {
			reqs = []string{"(not specified)"}
		}
		spec.Skills = append(spec.Skills, agent.PromptSkill{
			Name:         name,
			FilePath:     skillPromptFilePath(skillLoaded.ID),
			Description:  desc,
			Requirements: reqs,
		})

		log.Info("skill_loaded", "mode", mode, "name", name, "id", skillLoaded.ID, "path", skillLoaded.SkillMD)
	}

	ap := mapKeysSorted(declaredAuthProfiles)
	if len(ap) > 0 {
		log.Info("skills_auth_profiles_declared", "count", len(ap), "profiles", ap)
	}
	log.Info("skills_loaded", "mode", mode, "count", len(spec.Skills))
	return spec, loadedOrdered, ap, nil
}

func normalizeSkillsMode(raw string) (mode string, reason string) {
	m := strings.ToLower(strings.TrimSpace(raw))
	switch m {
	case "", "on", "explicit":
		return "on", ""
	case "smart":
		return "on", "legacy_smart_fallback_to_on"
	case "off", "none", "disabled":
		return "off", ""
	default:
		return "on", "unknown_mode_fallback_to_on"
	}
}

func skillsAutoFromViper() bool {
	if viper.IsSet("skills.auto") {
		return viper.GetBool("skills.auto")
	}
	if viper.IsSet("skills_auto") {
		return viper.GetBool("skills_auto")
	}
	return true
}

func getStringSlice(keys ...string) []string {
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if viper.IsSet(key) {
			return viper.GetStringSlice(key)
		}
	}
	return nil
}

func truncateString(s string, max int) string {
	if max <= 0 {
		return s
	}
	if len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}

func mapKeysSorted(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func skillPromptFilePath(skillID string) string {
	dirName := strings.TrimSpace(viper.GetString("skills.dir_name"))
	if dirName == "" {
		dirName = "skills"
	}
	id := strings.Trim(strings.TrimSpace(skillID), "/\\")
	if id == "" {
		return path.Join("file_state_dir", dirName, "SKILL.md")
	}
	return path.Join("file_state_dir", dirName, id, "SKILL.md")
}
