package main

import (
	"context"
	"fmt"
	"os"

	"github.com/quailyquaily/mistermorph/internal/elevate"
	"github.com/quailyquaily/mistermorph/internal/processrestart"
	"github.com/quailyquaily/mistermorph/internal/processsignal"
)

func main() {
	// Started by sudo as the askpass helper for an elevated command: show the approval dialog and
	// print the password for sudo, nothing else. Otherwise this binary is marked as the helper
	// elevated commands may use.
	elevate.HandleAskpass()
	ctx, stop := processsignal.NotifyContext(context.Background())
	err := ExecuteContext(ctx)
	stop()
	// A restart requested from the Console runs after the command has shut down cleanly.
	if processrestart.Requested() {
		if execErr := processrestart.Exec(); execErr != nil {
			fmt.Fprintf(os.Stderr, "restart failed: %v\n", execErr)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if err != nil {
		os.Exit(1)
	}
}
