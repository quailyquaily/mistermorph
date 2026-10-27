package consolecmd

import (
	"github.com/quailyquaily/mistermorph/internal/localconsole"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

func New(version ...string) *cobra.Command {
	buildVersion := ""
	if len(version) > 0 {
		buildVersion = version[0]
	}
	cmd := &cobra.Command{
		Use:   "console",
		Short: "Run console HTTP APIs and SPA",
		Args:  cobra.NoArgs,
	}
	serve := newServeCmd(buildVersion)
	cmd.AddCommand(serve)
	cmd.AddCommand(&cobra.Command{
		Use:   "stop",
		Short: "Stop the local Console runtime",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return localconsole.Stop(cmd.Context(), runtimepaths.FromReader(viper.GetViper()).StateDir)
		},
	})
	cmd.RunE = serve.RunE
	cmd.Flags().AddFlagSet(serve.Flags())
	return cmd
}
