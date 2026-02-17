package integration

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

func (rt *Runtime) buildGuard(cfg guardSnapshot, log *slog.Logger) *guard.Guard {
	if rt == nil || !rt.features.Guard || !cfg.Enabled {
		return nil
	}
	if log == nil {
		log = slog.Default()
	}

	guardDir := strings.TrimSpace(cfg.Dir)
	if guardDir == "" {
		guardDir = pathutil.ResolveStateChildDir("", "", "guard")
	}
	if err := os.MkdirAll(guardDir, 0o700); err != nil {
		log.Warn("guard_dir_create_error", "error", err.Error(), "guard_dir", guardDir)
		return nil
	}
	lockRoot := filepath.Join(guardDir, ".fslocks")

	jsonlPath := strings.TrimSpace(cfg.Config.Audit.JSONLPath)
	if jsonlPath == "" {
		jsonlPath = filepath.Join(guardDir, "audit", "guard_audit.jsonl")
	}
	jsonlPath = pathutil.ExpandHomePath(jsonlPath)

	var sink guard.AuditSink
	var warnings []string
	if strings.TrimSpace(jsonlPath) != "" {
		s, err := guard.NewJSONLAuditSink(jsonlPath, cfg.Config.Audit.RotateMaxBytes, lockRoot)
		if err != nil {
			log.Warn("guard_audit_sink_error", "error", err.Error())
			warnings = append(warnings, "guard_audit_sink_error: "+err.Error())
		} else {
			sink = s
		}
	}

	var approvals guard.ApprovalStore
	if cfg.Config.Approvals.Enabled {
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
		"url_fetch_prefixes", len(cfg.Config.Network.URLFetch.AllowedURLPrefixes),
		"audit_jsonl", jsonlPath,
		"approvals_enabled", approvals != nil,
	)

	if len(warnings) > 0 {
		return guard.NewWithWarnings(cfg.Config, sink, approvals, warnings)
	}
	return guard.New(cfg.Config, sink, approvals)
}
