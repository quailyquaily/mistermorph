package main

import (
	"context"
	"fmt"
	"os"

	"github.com/quailyquaily/mistermorph/internal/processrestart"
	"github.com/quailyquaily/mistermorph/internal/processsignal"
)

func main() {
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
