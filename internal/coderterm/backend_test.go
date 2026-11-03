package coderterm

import (
	"strings"
	"testing"
)

func TestBackendArgsBypassApprovals(t *testing.T) {
	for _, tc := range []struct {
		name           string
		b              backend
		resume, bypass bool
		want           string
	}{
		{name: "codex", b: codexBackend{}, want: "--no-daemon -c check_for_update_on_startup=false --ask-for-approval on-request --sandbox workspace-write"},
		{name: "codex yolo", b: codexBackend{}, bypass: true, want: "--no-daemon -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox"},
		{name: "codex yolo resume", b: codexBackend{}, resume: true, bypass: true, want: "resume sid --no-daemon -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox"},
		{name: "claude", b: claudeBackend{}, want: "--session-id sid --ax-screen-reader --permission-mode default"},
		{name: "claude skip permissions", b: claudeBackend{}, bypass: true, want: `--session-id sid --ax-screen-reader --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true}`},
		{name: "claude skip permissions resume", b: claudeBackend{}, resume: true, bypass: true, want: `--resume sid --ax-screen-reader --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := strings.Join(tc.b.args("sid", tc.resume, tc.bypass), " "); got != tc.want {
				t.Fatalf("args = %q, want %q", got, tc.want)
			}
		})
	}
}
