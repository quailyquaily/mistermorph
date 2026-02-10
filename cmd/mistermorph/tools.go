package main

import (
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/clifmt"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/cobra"
)

type toolPreview struct {
	Name        string
	Description string
}

func newToolsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tools",
		Short: "List available tools",
		RunE:  runToolsCmd,
	}
}

func runToolsCmd(cmd *cobra.Command, _ []string) error {
	r := registryFromViper()
	corePreviews := make(map[string]toolPreview, len(r.All()))
	for _, tool := range r.All() {
		name := strings.TrimSpace(tool.Name())
		if name == "" {
			continue
		}
		corePreviews[name] = toolPreview{
			Name:        name,
			Description: strings.TrimSpace(tool.Description()),
		}
	}

	extraPreviews := map[string]toolPreview{}
	// plan_create is injected in run/serve/telegram runtimes.
	toolsutil.RegisterPlanTool(r, nil, "")
	if t, ok := r.Get("plan_create"); ok {
		addToolPreview(extraPreviews, toolPreview{
			Name:        t.Name(),
			Description: t.Description(),
		})
	}

	telegramPreviews := map[string]toolPreview{}
	// Telegram-only tools are injected at runtime and are not part of the base registry.
	addToolPreview(telegramPreviews, toolPreview{
		Name:        "telegram_send_file",
		Description: "[telegram only] Sends a local file (under file_cache_dir) to the active chat.",
	})
	addToolPreview(telegramPreviews, toolPreview{
		Name:        "telegram_send_voice",
		Description: "[telegram only] Sends a voice message from local audio or synthesized text.",
	})
	addToolPreview(telegramPreviews, toolPreview{
		Name:        "telegram_react",
		Description: "[telegram only] Adds an emoji reaction to a Telegram message.",
	})

	out := cmd.OutOrStdout()
	coreRows := rowsFromToolPreviews(corePreviews)
	extraRows := rowsFromToolPreviews(extraPreviews)
	telegramRows := rowsFromToolPreviews(telegramPreviews)

	clifmt.PrintNameDetailTable(out, clifmt.NameDetailTableOptions{
		Title:          "Core tools",
		Rows:           coreRows,
		EmptyText:      "No core tools are registered.",
		NameHeader:     "NAME",
		DetailHeader:   "DESCRIPTION",
		MinDetailWidth: 36,
		EmptyDetail:    "No description provided.",
	})

	_, _ = out.Write([]byte("\n"))
	clifmt.PrintNameDetailTable(out, clifmt.NameDetailTableOptions{
		Title:          "Extra tools",
		Rows:           extraRows,
		EmptyText:      "No extra tools are available.",
		NameHeader:     "NAME",
		DetailHeader:   "DESCRIPTION",
		MinDetailWidth: 36,
		EmptyDetail:    "No description provided.",
	})

	_, _ = out.Write([]byte("\n"))
	clifmt.PrintNameDetailTable(out, clifmt.NameDetailTableOptions{
		Title:          "Telegram tools",
		Rows:           telegramRows,
		EmptyText:      "No Telegram tools are available.",
		NameHeader:     "NAME",
		DetailHeader:   "DESCRIPTION",
		MinDetailWidth: 36,
		EmptyDetail:    "No description provided.",
	})
	return nil
}

func addToolPreview(previews map[string]toolPreview, p toolPreview) {
	if previews == nil {
		return
	}
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return
	}
	if _, exists := previews[name]; exists {
		return
	}
	p.Name = name
	p.Description = strings.TrimSpace(p.Description)
	previews[name] = p
}

func rowsFromToolPreviews(previews map[string]toolPreview) []clifmt.NameDetailRow {
	if len(previews) == 0 {
		return nil
	}
	names := make([]string, 0, len(previews))
	for name := range previews {
		names = append(names, name)
	}
	sort.Strings(names)

	rows := make([]clifmt.NameDetailRow, 0, len(names))
	for _, name := range names {
		p := previews[name]
		rows = append(rows, clifmt.NameDetailRow{
			Name:   p.Name,
			Detail: p.Description,
		})
	}
	return rows
}
