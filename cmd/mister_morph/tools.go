package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newToolsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tools",
		Short: "List available tools",
		RunE: func(cmd *cobra.Command, args []string) error {
			r := registryFromViper()
			for _, t := range r.All() {
				fmt.Printf("%s: %s\n", t.Name(), t.Description())
			}
			return nil
		},
	}
}
