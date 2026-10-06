package builtin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

type contactsSendFileFixture struct {
	roots     pathroots.PathRoots
	cache     string
	workspace string
	state     string
	outside   string
}

func newContactsSendFileFixture(t *testing.T) contactsSendFileFixture {
	t.Helper()
	base := t.TempDir()
	f := contactsSendFileFixture{
		cache:     filepath.Join(base, "cache"),
		workspace: filepath.Join(base, "workspace"),
		state:     filepath.Join(base, "workspace", ".morph"),
		outside:   filepath.Join(base, "outside"),
	}
	for _, dir := range []string{f.cache, filepath.Join(f.cache, "reports"), f.workspace, f.state, f.outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeTestFile(t, filepath.Join(f.cache, "reports", "weekly.pdf"), "cache report")
	writeTestFile(t, filepath.Join(f.workspace, "notes.txt"), "workspace notes")
	writeTestFile(t, filepath.Join(f.state, "config.yaml"), "secret: 1")
	writeTestFile(t, filepath.Join(f.outside, "elsewhere.txt"), "outside")
	if err := os.Symlink(filepath.Join(f.outside, "elsewhere.txt"), filepath.Join(f.cache, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(f.cache, "reports", "weekly.pdf"), filepath.Join(f.workspace, "link.pdf")); err != nil {
		t.Fatal(err)
	}
	big, err := os.Create(filepath.Join(f.cache, "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := big.Truncate(contactsSendFileMaxBytes + 1); err != nil {
		t.Fatal(err)
	}
	_ = big.Close()
	f.roots = pathroots.New("", f.cache, f.state)
	return f
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParseContactsSendFile(t *testing.T) {
	f := newContactsSendFileFixture(t)
	ctx := pathroots.WithWorkspaceDir(context.Background(), f.workspace)
	cacheReport := filepath.Join(f.cache, "reports", "weekly.pdf")

	tests := []struct {
		name         string
		params       map[string]any
		wantPath     string
		wantFilename string
		wantErr      string
	}{
		{name: "no file", params: map[string]any{"message_text": "hi"}},
		{name: "cache relative", params: map[string]any{"path": "reports/weekly.pdf"}, wantPath: cacheReport, wantFilename: "weekly.pdf"},
		{name: "cache alias", params: map[string]any{"path": "file_cache_dir/reports/weekly.pdf", "filename": "Weekly Report.pdf"}, wantPath: cacheReport, wantFilename: "Weekly_Report.pdf"},
		{name: "cache absolute", params: map[string]any{"path": cacheReport}, wantPath: cacheReport, wantFilename: "weekly.pdf"},
		{name: "workspace relative", params: map[string]any{"path": "notes.txt", "message_text": ""}, wantPath: filepath.Join(f.workspace, "notes.txt"), wantFilename: "notes.txt"},
		{name: "workspace alias", params: map[string]any{"path": "workspace_dir/notes.txt"}, wantPath: filepath.Join(f.workspace, "notes.txt"), wantFilename: "notes.txt"},
		{name: "symlink between roots", params: map[string]any{"path": "workspace_dir/link.pdf"}, wantPath: cacheReport, wantFilename: "weekly.pdf"},
		{name: "state alias", params: map[string]any{"path": "file_state_dir/config.yaml"}, wantErr: "file_state_dir"},
		{name: "state inside workspace", params: map[string]any{"path": filepath.Join(f.state, "config.yaml")}, wantErr: "file_state_dir"},
		{name: "outside", params: map[string]any{"path": filepath.Join(f.outside, "elsewhere.txt")}, wantErr: "outside file_cache_dir and workspace_dir"},
		{name: "escaping symlink", params: map[string]any{"path": "escape.txt"}, wantErr: "outside file_cache_dir and workspace_dir"},
		{name: "missing", params: map[string]any{"path": "reports/missing.pdf"}, wantErr: "file not found"},
		{name: "directory", params: map[string]any{"path": "file_cache_dir/reports"}, wantErr: "directory"},
		{name: "oversized", params: map[string]any{"path": "big.bin"}, wantErr: "too large"},
		{name: "empty path", params: map[string]any{"path": "  "}, wantErr: "path must not be empty"},
		{name: "non-string path", params: map[string]any{"path": 7}, wantErr: "path must be a string"},
		{name: "non-string filename", params: map[string]any{"path": "reports/weekly.pdf", "filename": true}, wantErr: "filename must be a string"},
		{name: "filename without path", params: map[string]any{"filename": "x.pdf"}, wantErr: "filename requires path"},
		{name: "with message_base64", params: map[string]any{"path": "reports/weekly.pdf", "message_base64": "e30"}, wantErr: "message_base64"},
		{name: "non-string caption", params: map[string]any{"path": "reports/weekly.pdf", "message_text": 3}, wantErr: "message_text must be a string"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			file, err := parseContactsSendFile(ctx, tt.params, f.roots, contactsSendPolicy)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseContactsSendFile() error = %v", err)
			}
			if tt.wantPath == "" {
				if file != nil {
					t.Fatalf("file = %+v, want nil", file)
				}
				return
			}
			wantPath, _ := filepath.EvalSymlinks(tt.wantPath)
			if file.Path != wantPath || file.Filename != tt.wantFilename {
				t.Fatalf("file = %+v, want path %s filename %s", file, wantPath, tt.wantFilename)
			}
			raw, _ := os.ReadFile(wantPath)
			sum := sha256.Sum256(raw)
			if file.Size != int64(len(raw)) || file.SHA256 != hex.EncodeToString(sum[:]) {
				t.Fatalf("file size/hash = %d/%s", file.Size, file.SHA256)
			}
		})
	}
}

func TestParseContactsSendFileWithoutWorkspace(t *testing.T) {
	f := newContactsSendFileFixture(t)
	_, err := parseContactsSendFile(context.Background(), map[string]any{"path": "notes.txt"}, f.roots, contactsSendPolicy)
	if err == nil || !strings.Contains(err.Error(), "file not found") {
		t.Fatalf("error = %v, want file not found", err)
	}
}

func TestAgentSendRejectsFileParams(t *testing.T) {
	f := newContactsSendFileFixture(t)
	agentPolicy := contactSendExecutionPolicy{toolName: "agent_send", activeAgentsOnly: true}
	for _, params := range []map[string]any{
		{"path": "reports/weekly.pdf"},
		{"filename": "x.pdf"},
	} {
		_, err := parseContactsSendFile(context.Background(), params, f.roots, agentPolicy)
		if err == nil || !strings.Contains(err.Error(), "agent_send sends text only") {
			t.Fatalf("error = %v, want text-only rejection", err)
		}
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(NewAgentSendTool(ContactsSendToolOptions{}).ParameterSchema()), &schema); err != nil {
		t.Fatal(err)
	}
	props := schema["properties"].(map[string]any)
	if _, ok := props["path"]; ok {
		t.Fatalf("agent_send schema has path")
	}
	if err := json.Unmarshal([]byte(NewContactsSendTool(ContactsSendToolOptions{}).ParameterSchema()), &schema); err != nil {
		t.Fatal(err)
	}
	props = schema["properties"].(map[string]any)
	for _, key := range []string{"path", "filename"} {
		if _, ok := props[key]; !ok {
			t.Fatalf("contacts_send schema lacks %s", key)
		}
	}
}

type captureFileAuditSink struct{ events []guard.AuditEvent }

func (s *captureFileAuditSink) Emit(_ context.Context, e guard.AuditEvent) error {
	s.events = append(s.events, e)
	return nil
}

func (s *captureFileAuditSink) Close() error { return nil }

func TestExecuteContactsSendFile(t *testing.T) {
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	file := &contacts.ShareFile{Path: "/cache/weekly.pdf", Filename: "weekly.pdf", Size: 12, SHA256: "abc"}

	newService := func(t *testing.T) *contacts.Service {
		t.Helper()
		svc := contacts.NewService(contacts.NewFileStore(filepath.Join(t.TempDir(), "contacts")))
		for _, contact := range []contacts.Contact{
			{ContactID: "tg:@ann", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGUsername: "ann", TGGroupChatIDs: []int64{-1001}},
			{ContactID: "tg:@bob", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGUsername: "bob", TGGroupChatIDs: []int64{-1001}},
			{ContactID: "tg:@cid", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGUsername: "cid", TGGroupChatIDs: []int64{-2001}},
			{ContactID: "tg:42", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGPrivateChatID: 42},
		} {
			if _, err := svc.UpsertContact(context.Background(), contact, now); err != nil {
				t.Fatal(err)
			}
		}
		return svc
	}
	auditCtx := func() (context.Context, *captureFileAuditSink) {
		sink := &captureFileAuditSink{}
		g := guard.New(guard.Config{Enabled: true}, sink, nil)
		return guard.WithAuditContext(context.Background(), g, guard.Meta{RunID: "run"}), sink
	}

	t.Run("single file without caption", func(t *testing.T) {
		ctx, sink := auditCtx()
		sender := &recordingContactsSendSender{}
		out, err := executeContactsSendResolved(ctx, map[string]any{"contact_id": "tg:42"}, []string{"tg:42"}, "", file, newService(t), sender, now, contactsSendPolicy)
		if err != nil {
			t.Fatalf("execute error = %v", err)
		}
		if len(sender.calls) != 1 || sender.calls[0].decision.File != file {
			t.Fatalf("calls = %+v", sender.calls)
		}
		if got := decodeEnvelopePayload(t, sender.calls[0].decision.PayloadBase64)["text"]; got != "" {
			t.Fatalf("caption = %q, want empty", got)
		}
		if len(sink.events) != 1 || !strings.Contains(sink.events[0].ActionSummaryRedacted, "status=sent") || !strings.Contains(sink.events[0].ActionSummaryRedacted, `recipients="tg:42"`) {
			t.Fatalf("audit = %+v", sink.events)
		}
		if strings.Contains(out, "audit_error") {
			t.Fatalf("output = %s", out)
		}
	})

	t.Run("batch uploads once per destination and keeps mentions", func(t *testing.T) {
		ctx, sink := auditCtx()
		sender := &recordingContactsSendSender{}
		ids := []string{"tg:@ann", "tg:@bob", "tg:@cid"}
		_, err := executeContactsSendResolved(ctx, map[string]any{"contact_id": strings.Join(ids, ","), "message_text": "Report"}, ids, "", file, newService(t), sender, now, contactsSendPolicy)
		if err != nil {
			t.Fatalf("execute error = %v", err)
		}
		if len(sender.calls) != 2 {
			t.Fatalf("calls = %d, want 2", len(sender.calls))
		}
		wantCaptions := []string{"@ann @bob Report", "@cid Report"}
		for i, call := range sender.calls {
			if call.decision.File != file {
				t.Fatalf("call %d has no file", i)
			}
			if got := decodeEnvelopePayload(t, call.decision.PayloadBase64)["text"]; got != wantCaptions[i] {
				t.Fatalf("caption %d = %q, want %q", i, got, wantCaptions[i])
			}
		}
		if len(sink.events) != 2 {
			t.Fatalf("audit events = %d, want 2", len(sink.events))
		}
	})

	t.Run("partial delivery", func(t *testing.T) {
		ctx, sink := auditCtx()
		svc := newService(t)
		sender := &recordingContactsSendSender{err: &contacts.PartialDeliveryError{Err: fmt.Errorf("caption rejected")}}
		out, err := executeContactsSendResolved(ctx, map[string]any{"contact_id": "tg:42", "message_text": "hi"}, []string{"tg:42"}, "", file, svc, sender, now, contactsSendPolicy)
		if err != nil {
			t.Fatalf("execute error = %v", err)
		}
		var result struct {
			Outcome contacts.ShareOutcome `json:"outcome"`
		}
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatal(err)
		}
		if !result.Outcome.Accepted || !result.Outcome.Partial || !strings.Contains(result.Outcome.Error, "caption rejected") {
			t.Fatalf("outcome = %+v", result.Outcome)
		}
		if !strings.Contains(sink.events[0].ActionSummaryRedacted, "status=partial") {
			t.Fatalf("audit = %s", sink.events[0].ActionSummaryRedacted)
		}

		// A retry with the same key is deduped instead of uploading again.
		decision := sender.calls[0].decision
		sender.err = nil
		retry, err := svc.SendDecision(context.Background(), now, decision, sender)
		if err != nil {
			t.Fatalf("retry error = %v", err)
		}
		if !retry.Deduped || len(sender.calls) != 1 {
			t.Fatalf("retry = %+v, calls = %d", retry, len(sender.calls))
		}
	})
}
