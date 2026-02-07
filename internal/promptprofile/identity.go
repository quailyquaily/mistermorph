package promptprofile

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
)

func AppendIdentityPromptBlock(spec *agent.PromptSpec, log *slog.Logger) {
	if spec == nil {
		return
	}
	if log == nil {
		log = slog.Default()
	}

	path, err := workspaceIdentityPath()
	if err != nil {
		log.Warn("identity_path_resolve_failed", "error", err.Error())
		return
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("identity_load_failed", "path", path, "error", err.Error())
		}
		return
	}
	content := strings.TrimSpace(string(raw))
	if content == "" {
		return
	}

	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title: "Identity Profile",
		Content: "Loaded from workspace root `IDENTITY.md`. " +
			"Treat it as long-term self identity and speaking-style guidance.\n\n" +
			content,
	})
}

func AppendSoulPromptBlock(spec *agent.PromptSpec, log *slog.Logger) {
	if spec == nil {
		return
	}
	if log == nil {
		log = slog.Default()
	}

	path, err := workspaceSoulPath()
	if err != nil {
		log.Warn("soul_path_resolve_failed", "error", err.Error())
		return
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("soul_load_failed", "path", path, "error", err.Error())
		}
		return
	}
	content := strings.TrimSpace(string(raw))
	if content == "" {
		return
	}

	spec.Blocks = append(spec.Blocks, agent.PromptBlock{
		Title: "Soul Profile",
		Content: "Loaded from workspace root `SOUL.md`. " +
			"Treat it as core behavioral principles and long-term continuity guidance.\n\n" +
			content,
	})
}

func workspaceIdentityPath() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, "IDENTITY.md"), nil
}

func workspaceSoulPath() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, "SOUL.md"), nil
}
