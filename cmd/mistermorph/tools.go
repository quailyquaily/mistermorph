package main

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/clifmt"
	"github.com/spf13/cobra"
)

func newToolsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tools",
		Short: "List available tools",
		RunE:  runToolsCmd,
	}
}

func runToolsCmd(cmd *cobra.Command, _ []string) error {
	r := registryFromViper()
	all := r.All()
	rows := make([]clifmt.NameDetailRow, 0, len(all))
	for _, tool := range all {
		rows = append(rows, clifmt.NameDetailRow{
			Name:   tool.Name(),
			Detail: strings.TrimSpace(tool.Description()),
		})
	}

	clifmt.PrintNameDetailTable(cmd.OutOrStdout(), clifmt.NameDetailTableOptions{
		Title:          "Available tools",
		Rows:           rows,
		EmptyText:      "No tools are registered.",
		NameHeader:     "NAME",
		DetailHeader:   "DESCRIPTION",
		MinDetailWidth: 36,
		EmptyDetail:    "No description provided.",
	})
	return nil
}
