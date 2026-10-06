package guard

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// FileSend is what the audit log records about a local file a tool sent out.
type FileSend struct {
	Recipients []string `json:"recipients"`
	Path       string   `json:"path"`
	Filename   string   `json:"filename"`
	Size       int64    `json:"size"`
	SHA256     string   `json:"sha256"`
	// Status is "sent", "partial" (the file went out, its text did not) or "failed".
	Status string `json:"status"`
}

type ctxKeyAudit struct{}

type auditContext struct {
	guard *Guard
	meta  Meta
}

// WithAuditContext lets a tool running in ctx write to g's audit log, attributed to meta's run and
// step.
func WithAuditContext(ctx context.Context, g *Guard, meta Meta) context.Context {
	return context.WithValue(ctx, ctxKeyAudit{}, auditContext{guard: g, meta: meta})
}

// AuditFileSend records a file send in the audit log of the guard in ctx. Without an enabled guard
// there is no audit log, and it does nothing.
func AuditFileSend(ctx context.Context, toolName string, send FileSend) error {
	if ctx == nil {
		return nil
	}
	ac, ok := ctx.Value(ctxKeyAudit{}).(auditContext)
	if !ok || !ac.guard.Enabled() {
		return nil
	}
	meta := ac.meta
	meta.Time = time.Now().UTC()
	action := Action{Type: ActionFileSend, ToolName: strings.TrimSpace(toolName), Value: send}
	return ac.guard.emitAudit(ctx, meta, action, Result{RiskLevel: RiskLow, Decision: DecisionAllow}, "", "", "")
}

func (g *Guard) summarizeFileSend(a Action) string {
	send, _ := a.Value.(FileSend)
	return fmt.Sprintf("%s tool=%s status=%s recipients=%q path=%q filename=%q size=%d sha256=%s",
		ActionFileSend, strings.TrimSpace(a.ToolName), send.Status,
		g.redactAuditValue(strings.Join(send.Recipients, ","), 420),
		clipAuditValue(send.Path, 420), clipAuditValue(send.Filename, 160), send.Size, send.SHA256)
}
