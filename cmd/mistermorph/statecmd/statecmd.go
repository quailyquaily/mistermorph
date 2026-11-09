// Package statecmd is `morph state`: commands over the state folder as a whole.
package statecmd

import (
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/statefiles"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/statesnapshot"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// New returns the `state` command.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "state",
		Short: "Snapshot, export and import the agent's state",
	}
	cmd.AddCommand(newSnapshotCmd(), newExportCmd(), newImportCmd())
	return cmd
}

// locations is where the state is, after the root preflight loaded the config.
func locations() statefiles.Locations {
	paths := runtimepaths.FromReader(viper.GetViper())
	configPath := strings.TrimSpace(viper.GetString("config"))
	if configPath == "" {
		configPath = configstore.DBConfigPath(paths.StateDir)
	}
	return statefiles.Locations{
		ConfigPath:  configPath,
		StateDir:    paths.StateDir,
		ContactsDir: paths.ContactsDir,
		CronPath:    paths.CronPath,
	}
}

func newExportCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "export <dir>",
		Short: "Write the state as the files it was: config.yaml, persona/identity.yaml, persona/soul.md, HEARTBEAT.md, contacts and cron.yaml",
		Long: "Write the config, the identity and soul, the heartbeat workflows, the contacts and the TODO list into " +
			"<dir> as the files they were before agent.db, to edit them by hand or keep them in git. " +
			"morph state import <dir> reads them back.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := statefiles.Export(cmd.Context(), locations(), args[0])
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "exported %s: %s\n", args[0], strings.Join(result.Files, ", "))
			return nil
		},
	}
}

func newImportCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "import <dir>",
		Short: "Read the files morph state export writes back into the state",
		Long: "Read config.yaml, persona/identity.yaml, persona/soul.md, HEARTBEAT.md, contacts/ACTIVE.md, " +
			"contacts/INACTIVE.md and cron.yaml from <dir> back into the state. Each file replaces its part " +
			"of the state in one transaction; a file that is not there leaves its part as it is. Every file is " +
			"parsed before anything is saved.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := statefiles.Import(cmd.Context(), locations(), args[0])
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "imported %s: %s\n", args[0], strings.Join(result.Files, ", "))
			return nil
		},
	}
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
