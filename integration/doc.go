// Package integration provides a reusable wiring layer for embedding
// mistermorph capabilities into third-party Go programs.
//
// It wires common features such as built-in tools, plan/todo helpers,
// guard, skills prompt loading, and request/prompt inspect dumps.
// Built-in tools can be narrowed with Config.BuiltinToolNames.
//
// In addition to one-shot task execution (RunTask), it can also expose
// long-running channel runners via Runtime.NewTelegramBot(...),
// Runtime.NewSlackBot(...), Runtime.NewMixinBot(...), Runtime.NewDiscordBot(...),
// Runtime.NewWeChatBot(...), and Runtime.NewWhatsAppBot(...).
//
// Configuration is explicit via Config.Set(...) / Config.Overrides.
// The embedding host owns env/config-file loading and passes resolved values in.
//
// Note: this package snapshots config from explicit Config overrides plus
// integration defaults once during Runtime construction.
//
// Elevated commands (bash or powershell run as administrator after the user
// approves a system dialog) are off by default. To allow them, call
// RunAskpassIfRequested first thing in main and set
// tools.bash.elevation.enabled (Linux, macOS) or
// tools.powershell.elevation.enabled (Windows); see docs/integration.md.
// A program with an askpass program of its own names it in
// tools.bash.elevation.askpass instead of calling RunAskpassIfRequested;
// ElevateCommandEnv and the other Elevate constants are its contract.
package integration
