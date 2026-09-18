package chatcmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Chat executes locally unless the user explicitly selects a runtime URL.
func chatRuntimeClient(cmd *cobra.Command) (*remoteClient, error) {
	standalone, _ := cmd.Flags().GetBool("standalone")
	if !cmd.Flags().Changed("runtime-url") {
		return nil, nil
	}
	if standalone {
		return nil, fmt.Errorf("--standalone cannot be combined with --runtime-url")
	}
	var invalid string
	cmd.Flags().Visit(func(f *pflag.Flag) {
		switch f.Name {
		case "runtime-url", "topic", "config", "standalone":
		default:
			if invalid == "" {
				invalid = f.Name
			}
		}
	})
	if invalid != "" {
		return nil, fmt.Errorf("--%s requires local execution; --runtime-url uses the remote execution settings", invalid)
	}
	base, _ := cmd.Flags().GetString("runtime-url")
	base = strings.TrimSpace(base)
	token := strings.TrimSpace(os.Getenv(runtimeTokenEnv))
	if base == "" {
		return nil, fmt.Errorf("--runtime-url must not be empty")
	}
	return newRemoteClient(base, token)
}
