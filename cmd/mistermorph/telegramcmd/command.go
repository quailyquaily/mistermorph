package telegramcmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelopts"
	telegramruntime "github.com/quailyquaily/mistermorph/internal/channelruntime/telegram"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/spf13/cobra"
)

func NewCommand(d Dependencies) *cobra.Command {
	return newTelegramCmd(d)
}

func newTelegramCmd(d Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "telegram",
		Short: "Run a Telegram bot that chats with the agent",
		RunE: func(cmd *cobra.Command, args []string) error {
			token := strings.TrimSpace(configutil.FlagOrViperString(cmd, "telegram-bot-token", "telegram.bot_token"))
			if token == "" {
				return fmt.Errorf("missing telegram.bot_token (set via --telegram-bot-token or MISTER_MORPH_TELEGRAM_BOT_TOKEN)")
			}

			allowedIDsRaw := configutil.FlagOrViperStringArray(cmd, "telegram-allowed-chat-id", "telegram.allowed_chat_ids")
			allowedIDs := make([]int64, 0, len(allowedIDsRaw))
			parsedAllowedIDs, err := channelopts.ParseTelegramAllowedChatIDs(allowedIDsRaw)
			if err != nil {
				return err
			}
			allowedIDs = parsedAllowedIDs

			runOpts, err := channelopts.BuildTelegramRunOptions(channelopts.TelegramConfigFromViper(), channelopts.TelegramInput{
				BotToken:                      token,
				AllowedChatIDs:                allowedIDs,
				GroupTriggerMode:              strings.TrimSpace(configutil.FlagOrViperString(cmd, "telegram-group-trigger-mode", "telegram.group_trigger_mode")),
				AddressingConfidenceThreshold: configutil.FlagOrViperFloat64(cmd, "telegram-addressing-confidence-threshold", "telegram.addressing_confidence_threshold"),
				AddressingInterjectThreshold:  configutil.FlagOrViperFloat64(cmd, "telegram-addressing-interject-threshold", "telegram.addressing_interject_threshold"),
				WithMAEP:                      configutil.FlagOrViperBool(cmd, "with-maep", "telegram.with_maep"),
				MAEPListenAddrs:               configutil.FlagOrViperStringArray(cmd, "maep-listen", "maep.listen_addrs"),
				PollTimeout:                   configutil.FlagOrViperDuration(cmd, "telegram-poll-timeout", "telegram.poll_timeout"),
				TaskTimeout:                   configutil.FlagOrViperDuration(cmd, "telegram-task-timeout", "telegram.task_timeout"),
				MaxConcurrency:                configutil.FlagOrViperInt(cmd, "telegram-max-concurrency", "telegram.max_concurrency"),
				FileCacheDir:                  strings.TrimSpace(configutil.FlagOrViperString(cmd, "file-cache-dir", "file_cache_dir")),
				HealthListen:                  strings.TrimSpace(configutil.FlagOrViperString(cmd, "health-listen", "health.listen")),
				InspectPrompt:                 configutil.FlagOrViperBool(cmd, "inspect-prompt", ""),
				InspectRequest:                configutil.FlagOrViperBool(cmd, "inspect-request", ""),
			})
			if err != nil {
				return err
			}
			return telegramruntime.Run(cmd.Context(), telegramruntime.Dependencies(d), runOpts)
		},
	}

	cmd.Flags().String("telegram-bot-token", "", "Telegram bot token.")
	cmd.Flags().StringArray("telegram-allowed-chat-id", nil, "Allowed chat id(s). If empty, allows all.")
	cmd.Flags().String("telegram-group-trigger-mode", "smart", "Group trigger mode: strict|smart|talkative.")
	cmd.Flags().Float64("telegram-addressing-confidence-threshold", 0.6, "Minimum confidence (0-1) required to accept an addressing LLM decision.")
	cmd.Flags().Float64("telegram-addressing-interject-threshold", 0.6, "Minimum interject (0-1) allowed to accept an addressing LLM decision.")
	cmd.Flags().Bool("with-maep", false, "Start MAEP listener together with telegram mode.")
	cmd.Flags().StringArray("maep-listen", nil, "MAEP listen multiaddr for --with-maep (repeatable). Defaults to maep.listen_addrs or MAEP defaults.")
	cmd.Flags().Duration("telegram-poll-timeout", 30*time.Second, "Long polling timeout for getUpdates.")
	cmd.Flags().Duration("telegram-task-timeout", 0, "Per-message agent timeout (0 uses --timeout).")
	cmd.Flags().Int("telegram-max-concurrency", 3, "Max number of chats processed concurrently.")
	cmd.Flags().String("file-cache-dir", "~/.cache/morph", "Global temporary file cache directory (used for Telegram file handling).")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_telegram_YYYYMMDD_HHmmss.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_telegram_YYYYMMDD_HHmmss.md.")

	return cmd
}
