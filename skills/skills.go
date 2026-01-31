package skills

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type Skill struct {
	ID       string
	Name     string
	RootDir  string
	Dir      string
	SkillMD  string
	Contents string
}

type DiscoverOptions struct {
	Roots []string
}

func DefaultRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return nil
	}
	return []string{
		filepath.Join(home, ".codex", "skills"),
		filepath.Join(home, ".claude", "skills"),
	}
}

func Discover(opts DiscoverOptions) ([]Skill, error) {
	roots := opts.Roots
	if len(roots) == 0 {
		roots = DefaultRoots()
	}

	var out []Skill
	var firstErr error

	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		info, err := os.Stat(root)
		if err != nil {
			continue
		}
		if !info.IsDir() {
			continue
		}

		err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			if d.Name() != "SKILL.md" {
				return nil
			}

			dir := filepath.Dir(path)
			rel, relErr := filepath.Rel(root, dir)
			if relErr != nil {
				return nil
			}
			rel = filepath.ToSlash(rel)
			id := rel
			if id == "." || id == "" {
				id = filepath.Base(dir)
			}

			name := filepath.Base(dir)
			out = append(out, Skill{
				ID:      id,
				Name:    name,
				RootDir: root,
				Dir:     dir,
				SkillMD: path,
			})
			return nil
		})
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Name == out[j].Name {
			return out[i].ID < out[j].ID
		}
		return out[i].Name < out[j].Name
	})

	return out, firstErr
}

func Load(skill Skill, maxBytes int64) (Skill, error) {
	data, err := os.ReadFile(skill.SkillMD)
	if err != nil {
		return Skill{}, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		data = data[:maxBytes]
	}
	skill.Contents = string(data)
	return skill, nil
}

func LoadPreview(skill Skill, maxBytes int64) (Skill, error) {
	f, err := os.Open(skill.SkillMD)
	if err != nil {
		return Skill{}, err
	}
	defer f.Close()

	if maxBytes <= 0 {
		maxBytes = 2048
	}
	data, err := io.ReadAll(io.LimitReader(f, maxBytes))
	if err != nil {
		return Skill{}, err
	}
	skill.Contents = string(data)
	return skill, nil
}

func Resolve(skills []Skill, query string) (Skill, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return Skill{}, fmt.Errorf("empty skill query")
	}

	lower := strings.ToLower(q)
	for _, s := range skills {
		if strings.ToLower(s.ID) == lower {
			return s, nil
		}
	}
	for _, s := range skills {
		if strings.ToLower(s.Name) == lower {
			return s, nil
		}
	}
	return Skill{}, fmt.Errorf("skill not found: %s", query)
}

var dollarSkillRe = regexp.MustCompile(`\$(?P<name>[A-Za-z0-9_.-]+)`)

func ReferencedSkillNames(task string) []string {
	matches := dollarSkillRe.FindAllStringSubmatch(task, -1)
	if len(matches) == 0 {
		return nil
	}
	uniq := make(map[string]bool, len(matches))
	var out []string
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		name := strings.TrimSpace(m[1])
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if uniq[key] {
			continue
		}
		uniq[key] = true
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
