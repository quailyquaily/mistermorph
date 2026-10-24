package integration

import "github.com/quailyquaily/mistermorph/internal/elevate"

// RunAskpassIfRequested lets the program's agent run elevated commands on Linux and macOS
// (tools.bash.elevation, off by default in embedded programs). Call it first thing in main, before
// parsing flags or starting anything.
//
// An elevated command runs under `sudo -A`, and sudo starts the running executable, your program,
// as its askpass helper. When this process is that helper, RunAskpassIfRequested shows the approval
// dialog, prints the password for sudo and exits. Otherwise it returns at once. Until it has run,
// elevated commands are unavailable on Linux and macOS even with tools.bash.elevation.enabled set.
// Windows elevates through UAC and does not need it.
func RunAskpassIfRequested() {
	elevate.HandleAskpass()
}
