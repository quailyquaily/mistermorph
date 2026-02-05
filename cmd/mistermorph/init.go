package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/spf13/cobra"
)

func newInitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init [dir]",
		Short: "Initialize config.yaml, HEARTBEAT.md, and install built-in skills",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "~/.morph/"
			if len(args) == 1 && strings.TrimSpace(args[0]) != "" {
				dir = args[0]
			}
			dir = pathutil.ExpandHomePath(dir)
			if strings.TrimSpace(dir) == "" {
				return fmt.Errorf("invalid dir")
			}
			dir = filepath.Clean(dir)

			if err := os.MkdirAll(dir, 0o755); err != nil {
				return err
			}

			cfgPath := filepath.Join(dir, "config.yaml")
			if _, err := os.Stat(cfgPath); err == nil {
				return fmt.Errorf("config already exists: %s", cfgPath)
			}

			hbPath := filepath.Join(dir, "HEARTBEAT.md")
			if _, err := os.Stat(hbPath); err == nil {
				return fmt.Errorf("heartbeat already exists: %s", hbPath)
			}

			cfgBody, err := loadConfigExample()
			if err != nil {
				return err
			}
			cfgBody = patchInitConfig(cfgBody, dir)

			if err := os.WriteFile(cfgPath, []byte(cfgBody), 0o644); err != nil {
				return err
			}

			hbBody := defaultHeartbeatTemplate()
			if err := os.WriteFile(hbPath, []byte(hbBody), 0o644); err != nil {
				return err
			}

			skillsDir := filepath.Join(dir, "skills")
			if err := installBuiltInSkills(skillsDir, false, false, false); err != nil {
				return err
			}

			fmt.Printf("initialized %s\n", dir)
			return nil
		},
	}

	return cmd
}

func loadConfigExample() (string, error) {
	data, err := os.ReadFile("config.example.yaml")
	if err != nil {
		return "", fmt.Errorf("read config.example.yaml: %w", err)
	}
	return string(data), nil
}

func patchInitConfig(cfg string, dir string) string {
	if strings.TrimSpace(cfg) == "" {
		return cfg
	}
	dir = filepath.Clean(dir)
	dir = filepath.ToSlash(dir)
	checklistPath := filepath.ToSlash(filepath.Join(dir, "HEARTBEAT.md"))
	cfg = strings.ReplaceAll(cfg, `checklist_path: "~/.morph/HEARTBEAT.md"`, fmt.Sprintf(`checklist_path: "%s"`, checklistPath))
	cfg = strings.ReplaceAll(cfg, `- "~/.morph/skills"`, fmt.Sprintf(`- "%s"`, filepath.ToSlash(filepath.Join(dir, "skills"))))
	return cfg
}

func defaultHeartbeatTemplate() string {
	return strings.Join([]string{
		"# Heartbeat Checklist",
		"",
		"<!--",
		"- Add periodic checks here.",
		"- If empty, the agent will look at recent short-term memory and context.",
		"- Recent short-term TODO progress is appended automatically when available.",
		"- Keep it short; focus on actionable items.",
		"-->",
		"",
	}, "\n")
}
