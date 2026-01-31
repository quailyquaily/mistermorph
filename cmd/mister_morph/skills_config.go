package main

import (
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type skillsConfig struct {
	Roots         []string
	Mode          string
	Requested     []string
	Auto          bool
	MaxLoad       int
	PreviewBytes  int64
	CatalogLimit  int
	SelectTimeout time.Duration
	SelectorModel string
	Trace         bool
}

func skillsConfigFromViper(model string) skillsConfig {
	cfg := skillsConfig{
		Roots: getStringSlice(
			"skills.dirs",
			"skills_dirs",
			"skills_dir",
		),
		Mode: strings.TrimSpace(viper.GetString("skills.mode")),
		Auto: skillsAutoFromViper(),
		Requested: append(
			append([]string{}, viper.GetStringSlice("skill")...), // legacy
			viper.GetStringSlice("skills")...,                    // legacy
		),
		MaxLoad:       viper.GetInt("skills.max_load"),
		PreviewBytes:  viper.GetInt64("skills.preview_bytes"),
		CatalogLimit:  viper.GetInt("skills.catalog_limit"),
		SelectTimeout: viper.GetDuration("skills.select_timeout"),
		SelectorModel: strings.TrimSpace(viper.GetString("skills.selector_model")),
		Trace:         viper.GetBool("trace"),
	}
	cfg.Requested = append(cfg.Requested, getStringSlice("skills.load")...)
	if strings.TrimSpace(cfg.Mode) == "" {
		cfg.Mode = "smart"
	}
	if strings.TrimSpace(cfg.SelectorModel) == "" {
		cfg.SelectorModel = model
	}
	return cfg
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

func skillsConfigFromRunCmd(cmd *cobra.Command, model string) skillsConfig {
	cfg := skillsConfigFromViper(model)

	// Local flags override config/env.
	roots, _ := cmd.Flags().GetStringArray("skills-dir")
	if cmd.Flags().Changed("skills-dir") {
		cfg.Roots = roots
	}

	cfg.Mode = strings.TrimSpace(flagOrViperString(cmd, "skills-mode", "skills.mode"))
	cfg.Auto = flagOrViperBool(cmd, "skills-auto", "skills.auto")

	if cmd.Flags().Changed("skill") {
		cfg.Requested, _ = cmd.Flags().GetStringArray("skill")
	}

	cfg.MaxLoad = flagOrViperInt(cmd, "skills-max-load", "skills.max_load")
	cfg.PreviewBytes = flagOrViperInt64(cmd, "skills-preview-bytes", "skills.preview_bytes")
	cfg.CatalogLimit = flagOrViperInt(cmd, "skills-catalog-limit", "skills.catalog_limit")
	cfg.SelectTimeout = flagOrViperDuration(cmd, "skills-select-timeout", "skills.select_timeout")

	if strings.TrimSpace(cfg.Mode) == "" {
		cfg.Mode = "smart"
	}
	if strings.TrimSpace(cfg.SelectorModel) == "" {
		cfg.SelectorModel = model
	}

	return cfg
}
