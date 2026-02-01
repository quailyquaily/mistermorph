package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/quailyquaily/mister_morph/assets"
	"github.com/spf13/cobra"
)

func newSkillsInstallBuiltinCmd() *cobra.Command {
	var (
		dest         string
		dryRun       bool
		clean        bool
		skipExisting bool
	)

	cmd := &cobra.Command{
		Use:   "install",
		Short: "Install/update built-in skills into ~/.morph/skills",
		RunE: func(cmd *cobra.Command, args []string) error {
			home, err := os.UserHomeDir()
			if err != nil || strings.TrimSpace(home) == "" {
				return fmt.Errorf("cannot resolve home dir")
			}
			if strings.TrimSpace(dest) == "" {
				dest = filepath.Join(home, ".morph", "skills")
			}
			dest = expandHome(dest)
			if dest == "" {
				return fmt.Errorf("invalid dest")
			}

			// Discover built-in skill directories (assets/skills/<skill>/SKILL.md).
			entries, err := fs.ReadDir(assets.SkillsFS, "skills")
			if err != nil {
				return err
			}

			var skillDirs []string
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				skill := e.Name()
				if _, err := fs.Stat(assets.SkillsFS, filepath.ToSlash(filepath.Join("skills", skill, "SKILL.md"))); err == nil {
					skillDirs = append(skillDirs, skill)
				}
			}
			sort.Strings(skillDirs)
			if len(skillDirs) == 0 {
				return fmt.Errorf("no built-in skills found")
			}

			if !dryRun {
				if err := os.MkdirAll(dest, 0o755); err != nil {
					return err
				}
			}

			for _, skill := range skillDirs {
				srcRoot := filepath.ToSlash(filepath.Join("skills", skill))
				dstRoot := filepath.Join(dest, skill)

				if clean {
					if dryRun {
						fmt.Printf("rm -rf %s\n", dstRoot)
					} else {
						_ = os.RemoveAll(dstRoot)
					}
				}

				err := fs.WalkDir(assets.SkillsFS, srcRoot, func(path string, d fs.DirEntry, err error) error {
					if err != nil {
						return err
					}
					rel := strings.TrimPrefix(path, srcRoot)
					rel = strings.TrimPrefix(rel, "/")
					outPath := dstRoot
					if rel != "" {
						outPath = filepath.Join(dstRoot, filepath.FromSlash(rel))
					}

					if d.IsDir() {
						if rel == "" {
							// Root dir created below.
							return nil
						}
						if dryRun {
							fmt.Printf("mkdir -p %s\n", outPath)
							return nil
						}
						return os.MkdirAll(outPath, 0o755)
					}

					if skipExisting {
						if _, err := os.Stat(outPath); err == nil {
							return nil
						}
					}

					// Ensure parent dir.
					if !dryRun {
						if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
							return err
						}
					}

					if dryRun {
						fmt.Printf("write %s\n", outPath)
						return nil
					}

					data, err := fs.ReadFile(assets.SkillsFS, path)
					if err != nil {
						return err
					}
					tmp := outPath + ".tmp"
					if err := os.WriteFile(tmp, data, 0o644); err != nil {
						return err
					}
					if err := os.Rename(tmp, outPath); err != nil {
						_ = os.Remove(tmp)
						return err
					}
					return os.Chmod(outPath, builtinSkillFileMode(path))
				})
				if err != nil {
					return err
				}

				fmt.Printf("installed %s -> %s\n", skill, dstRoot)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&dest, "dest", "", "Destination directory (default: ~/.morph/skills)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Print operations without writing files")
	cmd.Flags().BoolVar(&clean, "clean", false, "Remove existing skill dir before copying (destructive)")
	cmd.Flags().BoolVar(&skipExisting, "skip-existing", false, "Skip files that already exist in destination")

	return cmd
}

func expandHome(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return filepath.Clean(p)
		}
		if p == "~" {
			return home
		}
		return filepath.Join(home, strings.TrimPrefix(p, "~/"))
	}
	return filepath.Clean(p)
}

func builtinSkillFileMode(path string) fs.FileMode {
	p := strings.ToLower(filepath.ToSlash(path))
	switch {
	case strings.HasSuffix(p, ".sh"):
		return 0o755
	case strings.Contains(p, "/scripts/"):
		return 0o755
	default:
		return 0o644
	}
}
