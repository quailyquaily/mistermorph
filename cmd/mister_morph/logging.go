package main

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

type loggerConfig struct {
	Level     string
	Format    string
	AddSource bool
}

func newLoggerFromConfig(cfg loggerConfig) (*slog.Logger, error) {
	level, err := parseSlogLevel(cfg.Level)
	if err != nil {
		return nil, err
	}

	opts := &slog.HandlerOptions{
		Level:     level,
		AddSource: cfg.AddSource,
	}

	var h slog.Handler
	switch strings.ToLower(strings.TrimSpace(cfg.Format)) {
	case "", "text":
		h = slog.NewTextHandler(os.Stderr, opts)
	case "json":
		h = slog.NewJSONHandler(os.Stderr, opts)
	default:
		return nil, fmt.Errorf("unknown logging.format: %s", cfg.Format)
	}

	return slog.New(h), nil
}

func parseSlogLevel(s string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, fmt.Errorf("unknown logging.level: %s", s)
	}
}
