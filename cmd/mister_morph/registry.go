package main

import (
	"time"

	"github.com/quailyquaily/mister_morph/tools"
	"github.com/quailyquaily/mister_morph/tools/builtin"
	"github.com/spf13/viper"
)

func registryFromViper() *tools.Registry {
	r := tools.NewRegistry()
	r.Register(builtin.NewEchoTool())
	r.Register(builtin.NewReadFileTool(256 * 1024))

	viper.SetDefault("tools.write_file.enabled", true)
	viper.SetDefault("tools.write_file.confirm", false)
	viper.SetDefault("tools.write_file.max_bytes", 512*1024)

	viper.SetDefault("tools.bash.enabled", false)
	viper.SetDefault("tools.bash.confirm", false)
	viper.SetDefault("tools.bash.timeout", 30*time.Second)
	viper.SetDefault("tools.bash.max_output_bytes", 256*1024)

	viper.SetDefault("tools.url_fetch.enabled", true)
	viper.SetDefault("tools.url_fetch.timeout", 30*time.Second)
	viper.SetDefault("tools.url_fetch.max_bytes", int64(512*1024))
	viper.SetDefault("tools.url_fetch.user_agent", "mister_morph/1.0 (+https://github.com/quailyquaily)")

	viper.SetDefault("tools.web_search.enabled", true)
	viper.SetDefault("tools.web_search.timeout", 20*time.Second)
	viper.SetDefault("tools.web_search.max_results", 5)
	viper.SetDefault("tools.web_search.base_url", "https://duckduckgo.com/html/")
	viper.SetDefault("tools.web_search.user_agent", "mister_morph/1.0 (+https://github.com/quailyquaily)")

	r.Register(builtin.NewWriteFileTool(
		viperGetBool("tools.write_file.enabled", "write_file_enabled"),
		viperGetBool("tools.write_file.confirm", "write_file_confirm"),
		viperGetInt("tools.write_file.max_bytes", "write_file_max_bytes"),
	))

	if viperGetBool("tools.bash.enabled", "bash_enabled") {
		r.Register(builtin.NewBashTool(
			true,
			viperGetBool("tools.bash.confirm", "bash_confirm"),
			viperGetDuration("tools.bash.timeout", "bash_timeout"),
			viperGetInt("tools.bash.max_output_bytes", "bash_max_output_bytes"),
		))
	}

	if viperGetBool("tools.url_fetch.enabled", "url_fetch_enabled") {
		r.Register(builtin.NewURLFetchTool(
			true,
			viperGetDuration("tools.url_fetch.timeout", "url_fetch_timeout"),
			viperGetInt64("tools.url_fetch.max_bytes", "url_fetch_max_bytes"),
			viperGetString("tools.url_fetch.user_agent", "url_fetch_user_agent"),
		))
	}

	if viperGetBool("tools.web_search.enabled", "web_search_enabled") {
		r.Register(builtin.NewWebSearchTool(
			true,
			viperGetString("tools.web_search.base_url", "web_search_base_url"),
			viperGetDuration("tools.web_search.timeout", "web_search_timeout"),
			viperGetInt("tools.web_search.max_results", "web_search_max_results"),
			viperGetString("tools.web_search.user_agent", "web_search_user_agent"),
		))
	}

	return r
}

func viperGetBool(key, legacy string) bool {
	if viper.IsSet(key) {
		return viper.GetBool(key)
	}
	return viper.GetBool(legacy)
}

func viperGetDuration(key, legacy string) time.Duration {
	if viper.IsSet(key) {
		return viper.GetDuration(key)
	}
	return viper.GetDuration(legacy)
}

func viperGetInt(key, legacy string) int {
	if viper.IsSet(key) {
		return viper.GetInt(key)
	}
	return viper.GetInt(legacy)
}

func viperGetInt64(key, legacy string) int64 {
	if viper.IsSet(key) {
		return viper.GetInt64(key)
	}
	return viper.GetInt64(legacy)
}

func viperGetString(key, legacy string) string {
	if viper.IsSet(key) {
		return viper.GetString(key)
	}
	return viper.GetString(legacy)
}
