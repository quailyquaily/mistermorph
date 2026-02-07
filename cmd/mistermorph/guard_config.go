package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/spf13/viper"
)

func guardFromViper(log *slog.Logger) *guard.Guard {
	if !viper.GetBool("guard.enabled") {
		return nil
	}
	if log == nil {
		log = slog.Default()
	}

	var patterns []guard.RegexPattern
	_ = viper.UnmarshalKey("guard.redaction.patterns", &patterns)

	cfg := guard.Config{
		Enabled: true,
		Network: guard.NetworkConfig{
			URLFetch: guard.URLFetchNetworkPolicy{
				AllowedURLPrefixes: viper.GetStringSlice("guard.network.url_fetch.allowed_url_prefixes"),
				DenyPrivateIPs:     viper.GetBool("guard.network.url_fetch.deny_private_ips"),
				FollowRedirects:    viper.GetBool("guard.network.url_fetch.follow_redirects"),
				AllowProxy:         viper.GetBool("guard.network.url_fetch.allow_proxy"),
			},
		},
		Redaction: guard.RedactionConfig{
			Enabled:  viper.GetBool("guard.redaction.enabled"),
			Patterns: patterns,
		},
		Bash: guard.BashConfig{
			RequireApproval: viper.GetBool("guard.bash.require_approval"),
		},
		Audit: guard.AuditConfig{
			JSONLPath:      strings.TrimSpace(viper.GetString("guard.audit.jsonl_path")),
			RotateMaxBytes: viper.GetInt64("guard.audit.rotate_max_bytes"),
		},
		Approvals: guard.ApprovalsConfig{
			Enabled: viper.GetBool("guard.approvals.enabled"),
		},
	}

	guardDir, err := resolveGuardDir()
	if err != nil {
		log.Warn("guard_dir_resolve_error", "error", err.Error())
		return nil
	}
	if err := os.MkdirAll(guardDir, 0o700); err != nil {
		log.Warn("guard_dir_create_error", "error", err.Error(), "guard_dir", guardDir)
		return nil
	}
	lockRoot := filepath.Join(guardDir, ".fslocks")

	jsonlPath := strings.TrimSpace(cfg.Audit.JSONLPath)
	if jsonlPath == "" {
		jsonlPath = filepath.Join(guardDir, "audit", "guard_audit.jsonl")
	}
	jsonlPath = pathutil.ExpandHomePath(jsonlPath)

	var sink guard.AuditSink
	var warnings []string
	if strings.TrimSpace(jsonlPath) != "" {
		s, err := guard.NewJSONLAuditSink(jsonlPath, cfg.Audit.RotateMaxBytes, lockRoot)
		if err != nil {
			log.Warn("guard_audit_sink_error", "error", err.Error())
			warnings = append(warnings, "guard_audit_sink_error: "+err.Error())
		} else {
			sink = s
		}
	}

	var approvals guard.ApprovalStore
	if cfg.Approvals.Enabled {
		approvalsPath := filepath.Join(guardDir, "approvals", "guard_approvals.json")
		st, err := guard.NewFileApprovalStore(approvalsPath, lockRoot)
		if err != nil {
			log.Warn("guard_approvals_store_error", "error", err.Error())
			warnings = append(warnings, "guard_approvals_store_error: "+err.Error())
		} else {
			approvals = st
		}
	}

	log.Info("guard_enabled",
		"guard_dir", guardDir,
		"url_fetch_prefixes", len(cfg.Network.URLFetch.AllowedURLPrefixes),
		"bash_require_approval", cfg.Bash.RequireApproval,
		"audit_jsonl", jsonlPath,
		"approvals_enabled", approvals != nil,
	)

	if len(warnings) > 0 {
		return guard.NewWithWarnings(cfg, sink, approvals, warnings)
	}
	return guard.New(cfg, sink, approvals)
}

func resolveGuardDir() (string, error) {
	base := pathutil.ResolveStateDir(viper.GetString("file_state_dir"))
	home, err := os.UserHomeDir()
	if strings.TrimSpace(base) == "" && err == nil && strings.TrimSpace(home) != "" {
		base = filepath.Join(home, ".morph")
	}
	if strings.TrimSpace(base) == "" {
		return "", fmt.Errorf("unable to resolve file_state_dir")
	}
	name := strings.TrimSpace(viper.GetString("guard.dir_name"))
	if name == "" {
		name = "guard"
	}
	return filepath.Join(base, name), nil
}
