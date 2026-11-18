// Package jobconfig names the job tool and its setting, with the names an earlier version used:
// the tool was todo_update and its switch tools.todo_update.enabled. The old names keep working.
package jobconfig

import "strings"

const (
	// ToolName is the tool that adds, reads, changes and deletes jobs.
	ToolName = "job_manage"
	// LegacyToolName is the tool's earlier name. A call, a tool selection or a $ reference by
	// this name reaches job_manage.
	LegacyToolName = "todo_update"

	// EnabledKey switches job_manage on and off.
	EnabledKey = "tools.job_manage.enabled"
	// LegacyEnabledKey is the earlier switch; it applies while EnabledKey is not set.
	LegacyEnabledKey = "tools.todo_update.enabled"
)

// Reader is the part of a config reader the switch needs.
type Reader interface {
	GetBool(string) bool
	IsSet(string) bool
}

// ToolEnabled reports whether job_manage is on: tools.job_manage.enabled when the config sets it,
// otherwise the earlier tools.todo_update.enabled (on by default).
func ToolEnabled(r Reader) bool {
	if r == nil {
		return false
	}
	if r.IsSet(EnabledKey) {
		return r.GetBool(EnabledKey)
	}
	return r.GetBool(LegacyEnabledKey)
}

// CanonicalToolName is name with the legacy tool name replaced by job_manage; any other name is
// returned as it is.
func CanonicalToolName(name string) string {
	if strings.EqualFold(strings.TrimSpace(name), LegacyToolName) {
		return ToolName
	}
	return name
}
