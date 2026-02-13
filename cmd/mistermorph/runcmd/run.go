package runcmd

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/heartbeatutil"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/logutil"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/skillsutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type Dependencies struct {
	RegistryFromViper func() *tools.Registry
	GuardFromViper    func(*slog.Logger) *guard.Guard
	RegisterPlanTool  func(*tools.Registry, llm.Client, string)
}

func New(deps Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run an agent task",
		RunE: func(cmd *cobra.Command, args []string) error {
			isHeartbeat := configutil.FlagOrViperBool(cmd, "heartbeat", "")
			task := ""
			var runMeta map[string]any
			if isHeartbeat {
				hbChecklist := statepaths.HeartbeatChecklistPath()
				hbTask, checklistEmpty, err := heartbeatutil.BuildHeartbeatTask(hbChecklist)
				if err != nil {
					return err
				}
				task = hbTask
				runMeta = heartbeatutil.BuildHeartbeatMeta(
					"cli",
					viper.GetDuration("heartbeat.interval"),
					hbChecklist,
					checklistEmpty,
					nil,
					nil,
				)
			} else {
				task = strings.TrimSpace(configutil.FlagOrViperString(cmd, "task", "task"))
				if task == "" {
					data, err := os.ReadFile("/dev/stdin")
					if err == nil {
						task = strings.TrimSpace(string(data))
					}
				}
				if task == "" {
					return fmt.Errorf("missing --task (or stdin)")
				}
			}

			provider := llmutil.ProviderFromViper()
			if cmd.Flags().Changed("provider") {
				provider = strings.TrimSpace(configutil.FlagOrViperString(cmd, "provider", ""))
			}
			endpoint := llmutil.EndpointForProvider(provider)
			if cmd.Flags().Changed("endpoint") {
				endpoint = strings.TrimSpace(configutil.FlagOrViperString(cmd, "endpoint", ""))
			}
			apiKey := llmutil.APIKeyForProvider(provider)
			if cmd.Flags().Changed("api-key") {
				apiKey = strings.TrimSpace(configutil.FlagOrViperString(cmd, "api-key", ""))
			}
			model := llmutil.ModelForProvider(provider)
			if cmd.Flags().Changed("model") {
				model = strings.TrimSpace(configutil.FlagOrViperString(cmd, "model", ""))
			}

			requestTimeout := configutil.FlagOrViperDuration(cmd, "llm-request-timeout", "llm.request_timeout")
			client, err := llmutil.ClientFromConfig(llmconfig.ClientConfig{
				Provider:       provider,
				Endpoint:       endpoint,
				APIKey:         apiKey,
				Model:          model,
				RequestTimeout: requestTimeout,
			})
			if err != nil {
				return err
			}

			timeout := configutil.FlagOrViperDuration(cmd, "timeout", "timeout")
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()

			logger, err := logutil.LoggerFromViper()
			if err != nil {
				return err
			}
			slog.SetDefault(logger)

			logOpts := logutil.LogOptionsFromViper()

			if configutil.FlagOrViperBool(cmd, "inspect-request", "") {
				inspector, err := llminspect.NewRequestInspector(llminspect.Options{
					Task: task,
				})
				if err != nil {
					return err
				}
				defer func() { _ = inspector.Close() }()
				if err := llminspect.SetDebugHook(client, inspector.Dump); err != nil {
					return fmt.Errorf("inspect-request requires uniai provider client")
				}
			}

			if configutil.FlagOrViperBool(cmd, "inspect-prompt", "") {
				inspector, err := llminspect.NewPromptInspector(llminspect.Options{
					Task: task,
				})
				if err != nil {
					return err
				}
				defer func() { _ = inspector.Close() }()
				client = &llminspect.PromptClient{Base: client, Inspector: inspector}
			}

			promptSpec, _, skillAuthProfiles, err := skillsutil.PromptSpecWithSkills(ctx, logger, logOpts, task, client, model, skillsutil.SkillsConfigFromRunCmd(cmd))
			if err != nil {
				return err
			}
			promptprofile.ApplyPersonaIdentity(&promptSpec, logger)
			promptprofile.AppendLocalToolNotesBlock(&promptSpec, logger)

			var hook agent.Hook
			if configutil.FlagOrViperBool(cmd, "interactive", "interactive") {
				hook, err = newInteractiveHook()
				if err != nil {
					return err
				}
			}

			var opts []agent.Option
			if hook != nil {
				opts = append(opts, agent.WithHook(hook))
			}
			opts = append(opts, agent.WithLogger(logger))
			opts = append(opts, agent.WithLogOptions(logOpts))
			opts = append(opts, agent.WithSkillAuthProfiles(skillAuthProfiles, viper.GetBool("secrets.require_skill_profiles")))
			if !isHeartbeat {
				opts = append(opts, agent.WithPlanStepUpdate(func(runCtx *agent.Context, update agent.PlanStepUpdate) {
					if payload := formatPlanProgressUpdate(runCtx, update); payload != "" {
						_, _ = fmt.Fprintln(os.Stdout, payload)
					}
				}))
			}
			if deps.GuardFromViper != nil {
				if g := deps.GuardFromViper(logger); g != nil {
					opts = append(opts, agent.WithGuard(g))
				}
			}
			reg := (*tools.Registry)(nil)
			if deps.RegistryFromViper != nil {
				reg = deps.RegistryFromViper()
			}
			if reg == nil {
				reg = tools.NewRegistry()
			}
			if deps.RegisterPlanTool != nil {
				deps.RegisterPlanTool(reg, client, model)
			}
			toolsutil.BindTodoUpdateToolLLM(reg, client, model)

			engine := agent.New(
				client,
				reg,
				agent.Config{
					MaxSteps:       configutil.FlagOrViperInt(cmd, "max-steps", "max_steps"),
					ParseRetries:   configutil.FlagOrViperInt(cmd, "parse-retries", "parse_retries"),
					MaxTokenBudget: configutil.FlagOrViperInt(cmd, "max-token-budget", "max_token_budget"),
				},
				promptSpec,
				opts...,
			)

			final, runCtx, err := engine.Run(ctx, task, agent.RunOptions{Model: model, Meta: runMeta})
			if err != nil {
				if errors.Is(err, errAbortedByUser) {
					return nil
				}
				return err
			}

			logger.Info("run_done",
				"steps", len(runCtx.Steps),
				"llm_rounds", runCtx.Metrics.LLMRounds,
				"total_tokens", runCtx.Metrics.TotalTokens,
				"parse_retries", runCtx.Metrics.ParseRetries,
			)

			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(final)
		},
	}

	cmd.Flags().String("task", "", "Task to run (if empty, reads from stdin).")
	cmd.Flags().Bool("heartbeat", false, "Run a single heartbeat check (ignores --task and stdin).")
	cmd.Flags().String("provider", "openai", "Provider: openai|openai_custom|deepseek|xai|gemini|azure|anthropic|bedrock|susanoo.")
	cmd.Flags().String("endpoint", "https://api.openai.com", "Base URL for provider.")
	cmd.Flags().String("model", "gpt-5.2", "Model name.")
	cmd.Flags().String("api-key", "", "API key.")
	cmd.Flags().Duration("llm-request-timeout", 90*time.Second, "Per-LLM HTTP request timeout (0 uses provider default).")
	cmd.Flags().Bool("interactive", false, "Ctrl-C pauses and lets you inject extra context, then continues.")
	cmd.Flags().Bool("inspect-prompt", false, "Dump prompts (messages) to ./dump/prompt_YYYYMMDD_HHmm.md.")
	cmd.Flags().Bool("inspect-request", false, "Dump LLM request/response payloads to ./dump/request_YYYYMMDD_HHmm.md.")
	cmd.Flags().StringArray("skills-dir", nil, "Skills root directory (repeatable). Default: file_state_dir/skills")
	cmd.Flags().StringArray("skill", nil, "Skill(s) to load by name or id (repeatable).")
	cmd.Flags().Bool("skills-auto", true, "Auto-load skills referenced in task via $SkillName.")
	cmd.Flags().String("skills-mode", "on", "Skills mode: off|on. Legacy values explicit/smart map to on.")

	cmd.Flags().Int("max-steps", 15, "Max tool-call steps.")
	cmd.Flags().Int("parse-retries", 2, "Max JSON parse retries.")
	cmd.Flags().Int("max-token-budget", 0, "Max cumulative token budget (0 disables).")

	cmd.Flags().Duration("timeout", 10*time.Minute, "Overall timeout.")

	return cmd
}

func formatPlanProgressUpdate(runCtx *agent.Context, update agent.PlanStepUpdate) string {
	if runCtx == nil || runCtx.Plan == nil {
		return ""
	}
	if update.CompletedIndex < 0 {
		return ""
	}
	total := len(runCtx.Plan.Steps)
	if total == 0 {
		return ""
	}
	payload := map[string]any{
		"type": "plan_step",
		"plan_step": map[string]any{
			"completed_index": update.CompletedIndex,
			"completed_step":  strings.TrimSpace(update.CompletedStep),
			"started_index":   update.StartedIndex,
			"started_step":    strings.TrimSpace(update.StartedStep),
			"total_steps":     total,
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(b)
}

var errAbortedByUser = errors.New("aborted by user")

func newInteractiveHook() (agent.Hook, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("interactive mode requires /dev/tty: %w", err)
	}

	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)

	r := bufio.NewReader(tty)

	return func(ctx context.Context, step int, agentCtx *agent.Context, messages *[]llm.Message) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-interrupts:
			_, _ = fmt.Fprintf(os.Stderr, "\n[interactive] paused at step=%d. Enter extra context (end with empty line).\n", step)
			_, _ = fmt.Fprintln(os.Stderr, "[interactive] commands: /continue (no-op), /abort (stop run)")
			note, err := readMultiline(r)
			if err != nil {
				return err
			}
			note = strings.TrimSpace(note)
			switch note {
			case "", "/continue":
				return nil
			case "/abort":
				return errAbortedByUser
			default:
				*messages = append(*messages, llm.Message{
					Role:    "user",
					Content: "Operator context:\n" + note,
				})
				_, _ = fmt.Fprintln(os.Stderr, "[interactive] context injected; continuing.")
				return nil
			}
		default:
			return nil
		}
	}, nil
}

func readMultiline(r *bufio.Reader) (string, error) {
	var lines []string
	for {
		line, err := r.ReadString('\n')
		if err != nil && line == "" {
			return "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(line) == "" {
			break
		}
		lines = append(lines, line)
		if err != nil {
			break
		}
	}
	return strings.Join(lines, "\n"), nil
}
