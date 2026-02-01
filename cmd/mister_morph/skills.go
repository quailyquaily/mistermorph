package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/quailyquaily/mister_morph/skills"
	"github.com/spf13/cobra"
)

func newSkillsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "skills",
		Short: "Discover and inspect SKILL.md skills",
	}

	cmd.AddCommand(newSkillsListCmd())
	cmd.AddCommand(newSkillsShowCmd())
	cmd.AddCommand(newSkillsInstallBuiltinCmd())
	return cmd
}

func newSkillsListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List discovered skills",
		RunE: func(cmd *cobra.Command, args []string) error {
			roots, _ := cmd.Flags().GetStringArray("skills-dir")
			if len(roots) == 0 {
				roots = getStringSlice(
					"skills.dirs",
					"skills_dirs",
					"skills_dir",
				)
			}
			list, err := skills.Discover(skills.DiscoverOptions{Roots: roots})
			if err != nil {
				return err
			}
			for _, s := range list {
				fmt.Printf("%s\t%s\t%s\n", s.Name, s.ID, s.SkillMD)
			}
			return nil
		},
	}

	cmd.Flags().StringArray("skills-dir", nil, "Skills root directory (repeatable). Defaults: ~/.morph/skills, ~/.claude/skills, ~/.codex/skills")

	return cmd
}

func newSkillsShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show <skill>",
		Short: "Print a skill's SKILL.md",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			roots, _ := cmd.Flags().GetStringArray("skills-dir")
			if len(roots) == 0 {
				roots = getStringSlice(
					"skills.dirs",
					"skills_dirs",
					"skills_dir",
				)
			}
			list, err := skills.Discover(skills.DiscoverOptions{Roots: roots})
			if err != nil {
				return err
			}

			s, err := skills.Resolve(list, args[0])
			if err != nil {
				return err
			}

			loaded, err := skills.Load(s, 512*1024)
			if err != nil {
				return err
			}

			_, err = fmt.Fprintln(os.Stdout, strings.TrimRight(loaded.Contents, "\n"))
			return err
		},
	}

	cmd.Flags().StringArray("skills-dir", nil, "Skills root directory (repeatable). Defaults: ~/.morph/skills, ~/.claude/skills, ~/.codex/skills")

	return cmd
}
