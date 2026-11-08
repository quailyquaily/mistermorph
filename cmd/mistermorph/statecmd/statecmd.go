// Package statecmd is `morph state`: commands over the state folder as a whole.
package statecmd

import (
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/statesnapshot"
	"github.com/spf13/cobra"
)

// New returns the `state` command.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "state",
		Short: "Snapshot, export and import the agent's state",
	}
	cmd.AddCommand(newSnapshotCmd())
	return cmd
}

func newSnapshotCmd() *cobra.Command {
	var skip []string
	cmd := &cobra.Command{
		Use:   "snapshot <dir>",
		Short: "Copy the state folder into <dir> consistently, while the agent runs",
		Long: "Copy the state folder into <dir>, which must not exist or be empty. Each SQLite database " +
			"(journal/journal.db, memory.db, agent.db, usage.db) is copied with VACUUM INTO, so the copy is " +
			"consistent even while the agent writes to it; every other file is copied as it is. " +
			"Back up the snapshot rather than the live folder.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			stateDir := statepaths.FileStateDir()
			result, err := statesnapshot.Take(cmd.Context(), stateDir, args[0], statesnapshot.Options{Skip: skip})
			if err != nil {
				return err
			}
			dbs := "none"
			if len(result.Databases) > 0 {
				dbs = strings.Join(result.Databases, ", ")
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "snapshot of %s in %s: databases %s; %d other files\n",
				stateDir, args[0], dbs, result.Files)
			return nil
		},
	}
	cmd.Flags().StringSliceVar(&skip, "skip", nil, "Databases to leave out: journal, memory, agent, usage (repeatable or comma-separated).")
	return cmd
}
