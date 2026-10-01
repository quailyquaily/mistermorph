package accountdm

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

func normalizeOptions(opts Options) Options {
	opts.FileCacheDir = strings.TrimSpace(opts.FileCacheDir)
	if opts.FileCacheDir == "" {
		opts.FileCacheDir = configdefaults.DefaultFileCacheDir
	}
	opts.FileCacheDir = pathutil.ExpandHomePath(opts.FileCacheDir)
	opts.ServerListen = strings.TrimSpace(opts.ServerListen)
	opts.ServerAuthToken = strings.TrimSpace(opts.ServerAuthToken)
	if opts.TaskTimeout <= 0 {
		opts.TaskTimeout = configdefaults.DefaultTaskTimeout
	}
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = configdefaults.DefaultChannelMaxConcurrency
	}
	if opts.BusMaxInFlight <= 0 {
		opts.BusMaxInFlight = configdefaults.DefaultBusMaxInFlight
	}
	if opts.ServerMaxQueue <= 0 {
		opts.ServerMaxQueue = configdefaults.DefaultServerMaxQueue
	}
	opts.AgentLimits = opts.AgentLimits.NormalizeForRuntime()
	return opts
}
