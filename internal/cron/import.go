package cron

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

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
