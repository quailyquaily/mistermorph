package main

import (
	"strings"

	"github.com/spf13/viper"
)

func getStringSlice(keys ...string) []string {
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if viper.IsSet(key) {
			return viper.GetStringSlice(key)
		}
	}
	return nil
}

func getBool(keys ...string) bool {
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if viper.IsSet(key) {
			return viper.GetBool(key)
		}
	}
	return false
}

func truncateString(s string, max int) string {
	if max <= 0 {
		return s
	}
	if len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}
