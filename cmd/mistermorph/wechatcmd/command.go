// Package wechatcmd is `morph wechat`: run the WeChat bot, and log it in with a QR code.
package wechatcmd

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/accountdmcmd"
	"github.com/quailyquaily/mistermorph/internal/channelopts"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	awarenessruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	wechatruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/wechat"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/wechatapi"
	"github.com/quailyquaily/mistermorph/internal/wechatlogin"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type Dependencies struct {
	awarenessruntime.Dependencies
	HandleModelCommand accountdm.HandleModelCommandFunc
	HandleSkillCommand accountdm.HandleSkillCommandFunc
	// ConfigPath is the config file `login` writes to.
	ConfigPath func() (string, error)
}

func NewCommand(d Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "wechat",
		Short: "Run a WeChat bot (private chats, over Tencent's iLink protocol)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := channelopts.WeChatConfigFromViper()
			if token := strings.TrimSpace(configutil.FlagOrViperString(cmd, "wechat-bot-token", "wechat.bot_token")); token != "" {
				cfg.BotToken = token
			}
			if ids := configutil.FlagOrViperStringArray(cmd, "wechat-allowed-user-id", "wechat.allowed_user_ids"); len(ids) > 0 {
				cfg.AllowedUserIDs = ids
			}
			if timeout := configutil.FlagOrViperDuration(cmd, "wechat-task-timeout", "wechat.task_timeout"); timeout > 0 {
				cfg.TaskTimeout = timeout
			}
			if n := configutil.FlagOrViperInt(cmd, "wechat-max-concurrency", "wechat.max_concurrency"); n > 0 {
				cfg.MaxConcurrency = n
			}
			runOpts := channelopts.BuildWeChatRunOptions(cfg, "morph wechat",
				configutil.FlagOrViperBool(cmd, "inspect-prompt", ""), configutil.FlagOrViperBool(cmd, "inspect-request", ""))
			runtimeToolsConfig := toolsutil.LoadRuntimeToolsRegisterConfigFromViper()
			deps := accountdm.Dependencies{
				CommonDependencies: depsutil.ApplyRuntimeConfig(d.Dependencies, runtimeToolsConfig, viper.GetViper()),
				HandleModelCommand: d.HandleModelCommand,
				HandleSkillCommand: d.HandleSkillCommand,
			}
			return accountdmcmd.Run(cmd.Context(), "wechat", d.Dependencies, deps, &runOpts.Options, func(ctx context.Context) error {
				return wechatruntime.Run(ctx, deps, runOpts)
			})
		},
	}
	cmd.Flags().String("wechat-bot-token", "", "WeChat bot token (normally written by `morph wechat login`).")
	cmd.Flags().StringArray("wechat-allowed-user-id", nil, "Allowed WeChat user id(s). If empty, allows everyone who can reach the bot.")
	cmd.Flags().Duration("wechat-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("wechat-max-concurrency", 0, "Max number of WeChat conversations processed concurrently.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_wechat_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_wechat_YYYYMMDD_HHmmss.md.")
	cmd.AddCommand(newLoginCommand(d), newLogoutCommand(d))
	return cmd
}

func newLoginCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Connect a WeChat bot by scanning a QR code",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := resolveConfigPath(d)
			if err != nil {
				return err
			}
			return login(cmd.Context(), cmd.OutOrStdout(), bufio.NewReader(cmd.InOrStdin()), configPath, secref.NewOSStore(), wechatlogin.Options{})
		},
	}
}

func newLogoutCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Disconnect the WeChat bot and delete its token",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := resolveConfigPath(d)
			if err != nil {
				return err
			}
			if err := wechatlogin.Unbind(cmd.Context(), configPath, secref.NewOSStore()); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Disconnected. Removed the WeChat bot from %s.\n", configPath)
			return nil
		},
	}
}

func resolveConfigPath(d Dependencies) (string, error) {
	if d.ConfigPath == nil {
		return "", fmt.Errorf("config path is unavailable")
	}
	return d.ConfigPath()
}

// login runs one QR login, printing each state, and saves the credentials.
func login(ctx context.Context, out io.Writer, in *bufio.Reader, configPath string, store secref.OSStore, opts wechatlogin.Options) error {
	session, err := wechatlogin.Start(ctx, opts)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Open this link and scan its QR code with WeChat (or log in from Console: Settings > Channels > WeChat):")
	fmt.Fprintln(out, "  "+qrDisplay(session.Image()))
	verifyCode := ""
	last := ""
	for {
		step, err := session.Poll(ctx, verifyCode)
		if err != nil {
			return err
		}
		verifyCode = ""
		if step.Message != last {
			fmt.Fprintln(out, step.Message)
			last = step.Message
		}
		if step.Status == wechatapi.QRNeedVerifyCode {
			fmt.Fprint(out, "Verification code: ")
			line, readErr := in.ReadString('\n')
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return readErr
			}
			verifyCode = strings.TrimSpace(line)
			continue
		}
		if !step.Done {
			continue
		}
		if step.Result == nil {
			return fmt.Errorf("wechat login did not complete: %s", step.Message)
		}
		if err := wechatlogin.Save(ctx, configPath, store, *step.Result); err != nil {
			if errors.Is(err, wechatlogin.ErrKeyringUnavailable) {
				fmt.Fprintf(out, "The system keyring is not available, so the token was not saved.\nSet it in the environment instead:\n  export MISTER_MORPH_WECHAT_BOT_TOKEN=%s\nand add to %s:\n  wechat:\n    bot_id: %q\n    base_url: %q\n", step.Result.BotToken, configPath, step.Result.BotID, step.Result.BaseURL)
				return nil
			}
			return err
		}
		fmt.Fprintf(out, "Connected bot %s. Saved to %s (the token is in the system keyring).\nStart it with: morph wechat\n", step.Result.BotID, configPath)
		if step.Result.UserID != "" {
			fmt.Fprintf(out, "Scanned by %s; add it to wechat.allowed_user_ids to keep everyone else out.\n", step.Result.UserID)
		}
		return nil
	}
}

// qrDisplay is the QR code to show: a URL as is; image content saved to a file, as its path.
func qrDisplay(image string) string {
	image = strings.TrimSpace(image)
	if strings.HasPrefix(image, "http://") || strings.HasPrefix(image, "https://") || image == "" {
		return image
	}
	file, err := os.CreateTemp("", "morph-wechat-qr-*.txt")
	if err != nil {
		return image
	}
	defer file.Close()
	_, _ = file.WriteString(image)
	return "QR content saved to " + file.Name()
}
