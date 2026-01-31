package main

import (
	"strings"
	"time"

	"github.com/spf13/cobra"
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

func truncateString(s string, max int) string {
	if max <= 0 {
		return s
	}
	if len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}

func flagOrViperString(cmd *cobra.Command, flagName, viperKey string) string {
	v, _ := cmd.Flags().GetString(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetString(viperKey)
	}
	return v
}

func flagOrViperStringArray(cmd *cobra.Command, flagName, viperKey string) []string {
	v, _ := cmd.Flags().GetStringArray(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetStringSlice(viperKey)
	}
	return v
}

func flagOrViperBool(cmd *cobra.Command, flagName, viperKey string) bool {
	v, _ := cmd.Flags().GetBool(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetBool(viperKey)
	}
	return v
}

func flagOrViperInt(cmd *cobra.Command, flagName, viperKey string) int {
	v, _ := cmd.Flags().GetInt(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetInt(viperKey)
	}
	return v
}

func flagOrViperInt64(cmd *cobra.Command, flagName, viperKey string) int64 {
	v, _ := cmd.Flags().GetInt64(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetInt64(viperKey)
	}
	return v
}

func flagOrViperDuration(cmd *cobra.Command, flagName, viperKey string) time.Duration {
	v, _ := cmd.Flags().GetDuration(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetDuration(viperKey)
	}
	return v
}

func flagOrViperFloat64(cmd *cobra.Command, flagName, viperKey string) float64 {
	v, _ := cmd.Flags().GetFloat64(flagName)
	if cmd.Flags().Changed(flagName) {
		return v
	}
	if viperKey != "" && viper.IsSet(viperKey) {
		return viper.GetFloat64(viperKey)
	}
	return v
}
