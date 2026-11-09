package cron

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"gopkg.in/yaml.v3"
)

func init() {
	agentdb.Register(agentdb.Importer{Name: "cron", Order: 40, Run: importCronFile})
}

// importCronFile reads cron.yaml into cron_tasks, in its order. A task that does not validate (or
// repeats an id) is listed as a reject and the others are imported. A file that does not parse is
// listed whole and left in place.
func importCronFile(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	raw, err := os.ReadFile(filepath.Join(env.StateDir, DefaultFilename))
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	file, err := ParseFile(string(raw))
	if err != nil {
		result.Rejects = append(result.Rejects, stateimport.Reject{Source: DefaultFilename, Error: err.Error(), Raw: string(raw)})
		return result, nil
	}
	var kept []Task
	seen := map[string]bool{}
	for i, task := range file.Tasks {
		task.ID = strings.TrimSpace(task.ID)
		if task.ID == "" {
			task.ID = normalizeTaskID("")
		}
		err := ValidateTask(task)
		if err == nil && seen[task.ID] {
			err = fmt.Errorf("duplicate task id: %s", task.ID)
		}
		if err != nil {
			encoded, _ := yaml.Marshal(task)
			result.Rejects = append(result.Rejects, stateimport.Reject{Source: DefaultFilename, Line: i + 1, Error: err.Error(), Raw: string(encoded)})
			continue
		}
		seen[task.ID] = true
		kept = append(kept, task)
	}
	if err := writeTasks(ctx, tx, File{Version: Version, Tasks: kept}); err != nil {
		return result, err
	}
	result.Rename = append(result.Rename, DefaultFilename)
	return result, nil
}

// ParseFile reads cron.yaml text. Empty text is an empty list.
func ParseFile(text string) (File, error) {
	if strings.TrimSpace(text) == "" {
		return File{Version: Version, Tasks: []Task{}}, nil
	}
	var file File
	if err := yaml.Unmarshal([]byte(text), &file); err != nil {
		return File{}, fmt.Errorf("parse cron.yaml: %w", err)
	}
	if file.Version == 0 {
		file.Version = Version
	}
	if file.Version != Version {
		return File{}, fmt.Errorf("unsupported cron file version: %d", file.Version)
	}
	if file.Tasks == nil {
		file.Tasks = []Task{}
	}
	for i := range file.Tasks {
		file.Tasks[i].Title = normalizeTaskTitle(file.Tasks[i].Title)
	}
	return file, nil
}

// RenderFile writes the list as cron.yaml text, as the file was.
func RenderFile(file File) (string, error) {
	if file.Version == 0 {
		file.Version = Version
	}
	if file.Tasks == nil {
		file.Tasks = []Task{}
	}
	raw, err := yaml.Marshal(file)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
