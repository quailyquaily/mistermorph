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
		dir            string
		want           string
	}{
		{name: "codex", b: codexBackend{}, want: "--no-daemon -c check_for_update_on_startup=false --ask-for-approval on-request --sandbox workspace-write"},
		{name: "codex yolo", b: codexBackend{}, bypass: true, want: "--no-daemon -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox"},
		{name: "codex yolo resume", b: codexBackend{}, resume: true, bypass: true, want: "resume sid --no-daemon -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox"},
		{name: "claude", b: claudeBackend{}, want: "--session-id sid --ax-screen-reader --permission-mode default"},
		{name: "claude skip permissions", b: claudeBackend{}, bypass: true, want: `--session-id sid --ax-screen-reader --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true}`},
		{name: "claude skip permissions resume", b: claudeBackend{}, resume: true, bypass: true, want: `--resume sid --ax-screen-reader --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true}`},
		// With the session's folder, the status line command keeps Claude's status JSON there.
		{name: "claude status line", b: claudeBackend{}, dir: "/logs/it's", want: `--session-id sid --ax-screen-reader --permission-mode default --settings {"statusLine":{"command":"cat > '/logs/it'\\''s/statusline.json'","padding":0,"type":"command"}}`},
		{name: "claude status line skip permissions", b: claudeBackend{}, bypass: true, dir: "/logs", want: `--session-id sid --ax-screen-reader --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true,"statusLine":{"command":"cat > '/logs/statusline.json'","padding":0,"type":"command"}}`},
		{name: "codex ignores the folder", b: codexBackend{}, dir: "/logs", want: "--no-daemon -c check_for_update_on_startup=false --ask-for-approval on-request --sandbox workspace-write"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := strings.Join(tc.b.args("sid", tc.resume, tc.bypass, tc.dir), " "); got != tc.want {
				t.Fatalf("args = %q, want %q", got, tc.want)
			}
		})
	}
}
