// Package xcmd is `morph x`: run an X (Twitter) account (direct messages and mentions), and
// `morph x login` to authorize it.
package xcmd

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/accountdmcmd"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	xruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/xchannel"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/xapi"
	"github.com/quailyquaily/mistermorph/internal/xlogin"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type Dependencies struct {
	awarenessruntime.Dependencies
	HandleModelCommand accountdm.HandleModelCommandFunc
	HandleSkillCommand accountdm.HandleSkillCommandFunc
}

func NewCommand(d Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "x",
		Short: "Run an X (Twitter) account: answer direct messages and public mentions",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := channelopts.XConfigFromViper()
			if value := strings.TrimSpace(configutil.FlagOrViperString(cmd, "x-refresh-token", "x.refresh_token")); value != "" {
				cfg.RefreshToken = value
			}
			if timeout := configutil.FlagOrViperDuration(cmd, "x-task-timeout", "x.task_timeout"); timeout > 0 {
				cfg.TaskTimeout = timeout
			}
			if n := configutil.FlagOrViperInt(cmd, "x-max-concurrency", "x.max_concurrency"); n > 0 {
				cfg.MaxConcurrency = n
			}
			runOpts := channelopts.BuildXRunOptions(cfg, "morph x",
				configutil.FlagOrViperBool(cmd, "inspect-prompt", ""), configutil.FlagOrViperBool(cmd, "inspect-request", ""))
			runtimeToolsConfig := toolsutil.LoadRuntimeToolsRegisterConfigFromViper()
			deps := accountdm.Dependencies{
				CommonDependencies: depsutil.ApplyRuntimeConfig(d.Dependencies, runtimeToolsConfig, viper.GetViper()),
				HandleModelCommand: d.HandleModelCommand,
				HandleSkillCommand: d.HandleSkillCommand,
			}
			return accountdmcmd.Run(cmd.Context(), "x", d.Dependencies, deps, &runOpts.Options, func(ctx context.Context) error {
				return xruntime.Run(ctx, deps, runOpts)
			})
		},
	}
	cmd.Flags().String("x-refresh-token", "", "A refresh token to use instead of the saved login (for headless setups).")
	cmd.Flags().Duration("x-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("x-max-concurrency", 0, "Max number of X conversations processed concurrently.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_x_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_x_YYYYMMDD_HHmmss.md.")
	cmd.AddCommand(newLoginCommand(), newLogoutCommand())
	return cmd
}

func newLoginCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authorize the agent's X account",
		Long: "Opens X's authorization page for the app in x.client_id. Sign in as the agent's account (not your own) and approve;\n" +
			"the login is saved in file_state_dir/auth/x.json, and `morph x` uses it from then on.",
		RunE: func(cmd *cobra.Command, args []string) error {
			clientID := strings.TrimSpace(viper.GetString("x.client_id"))
			if clientID == "" {
				return fmt.Errorf("x.client_id is required: register an app in the X Developer Console first")
			}
			redirect, _ := cmd.Flags().GetString("redirect-url")
			session, err := xapi.StartLogin(xapi.LoginOptions{
				ClientID: clientID, ClientSecret: strings.TrimSpace(viper.GetString("x.client_secret")),
				RedirectURL: redirect, BaseURL: strings.TrimSpace(viper.GetString("x.base_url")),
			})
			if err != nil {
				return err
			}
			defer session.Close()
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "Open this URL, sign in as the agent's X account, and approve:\n\n  %s\n\nWaiting for X to redirect back...\n", session.AuthorizeURL)
			ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Minute)
			defer cancel()
			token, err := session.Wait(ctx)
			if err != nil {
				return err
			}
			if err := xlogin.Save(viper.GetString("file_state_dir"), token); err != nil {
				return err
			}
			fmt.Fprintf(out, "\nLogged in as @%s. `morph x` will use this account.\n", token.Username)
			return nil
		},
	}
	cmd.Flags().String("redirect-url", xapi.DefaultRedirectURL, "Callback URL registered for the X app (http://127.0.0.1:<port>/<path>).")
	return cmd
}

func newLogoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Forget the X login saved by `morph x login`",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := xlogin.Logout(viper.GetString("file_state_dir")); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Logged out of X.")
			return nil
		},
	}
}
