package contactsruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/livesend"
	"github.com/quailyquaily/mistermorph/internal/mixinapi"
)

// fileRequest is one request a fake platform server received.
type fileRequest struct {
	path     string
	fields   map[string]string
	filename string
	file     string
	json     map[string]any
}

type fakePlatform struct {
	mu       sync.Mutex
	requests []fileRequest
	reply    func(path string) (int, string)
}

func (p *fakePlatform) serve(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := fileRequest{path: r.URL.Path, fields: map[string]string{}}
		contentType := r.Header.Get("Content-Type")
		switch {
		case strings.HasPrefix(contentType, "multipart/"):
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				t.Errorf("ParseMultipartForm() error = %v", err)
			}
			for key, values := range r.MultipartForm.Value {
				req.fields[key] = values[0]
			}
			for _, headers := range r.MultipartForm.File {
				f, _ := headers[0].Open()
				raw, _ := io.ReadAll(f)
				req.filename, req.file = headers[0].Filename, string(raw)
			}
		case strings.HasPrefix(contentType, "application/json"):
			_ = json.NewDecoder(r.Body).Decode(&req.json)
		case strings.HasPrefix(contentType, "application/x-www-form-urlencoded"):
			_ = r.ParseForm()
			for key := range r.PostForm {
				req.fields[key] = r.PostForm.Get(key)
			}
		default:
			raw, _ := io.ReadAll(r.Body)
			req.file = string(raw)
		}
		p.mu.Lock()
		p.requests = append(p.requests, req)
		p.mu.Unlock()
		status, body := http.StatusOK, `{"ok":true,"code":0}`
		if p.reply != nil {
			status, body = p.reply(r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (p *fakePlatform) paths() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, 0, len(p.requests))
	for _, req := range p.requests {
		out = append(out, req.path)
	}
	return out
}

func writeShareFile(t *testing.T, content string) *contacts.ShareFile {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "weekly.pdf")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return &contacts.ShareFile{Path: path, Filename: "weekly-report.pdf", Size: int64(len(content)), SHA256: "x"}
}

func fileDecision(contactID string, file *contacts.ShareFile, caption string) contacts.ShareDecision {
	envelope, _ := json.Marshal(map[string]any{"message_id": "m1", "text": caption, "sent_at": "2026-10-06T10:00:00Z", "session_id": uuid.Must(uuid.NewV7()).String()})
	return contacts.ShareDecision{
		ContactID:      contactID,
		ContentType:    "application/json",
		PayloadBase64:  base64.RawURLEncoding.EncodeToString(envelope),
		IdempotencyKey: "manual:" + uuid.NewString(),
		File:           file,
	}
}

func newFileSender(t *testing.T, opts SenderOptions) *RoutingSender {
	t.Helper()
	sender, err := NewRoutingSender(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sender.Close() })
	return sender
}

func TestSendTelegramFile(t *testing.T) {
	contact := contacts.Contact{ContactID: "tg:42", Channel: contacts.ChannelTelegram, TGPrivateChatID: 42}
	tests := []struct {
		name        string
		caption     string
		failText    bool
		wantPaths   []string
		wantCaption string
		wantPartial bool
	}{
		{name: "caption attached", caption: "This week's report.", wantPaths: []string{"/botT/sendDocument"}, wantCaption: "This week's report."},
		{name: "no caption", wantPaths: []string{"/botT/sendDocument"}},
		{name: "long caption follows", caption: strings.Repeat("a", 1100), wantPaths: []string{"/botT/sendDocument", "/botT/sendMessage"}},
		{name: "caption fails after file", caption: strings.Repeat("a", 1100), failText: true, wantPaths: []string{"/botT/sendDocument", "/botT/sendMessage"}, wantPartial: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform := &fakePlatform{}
			if tt.failText {
				platform.reply = func(path string) (int, string) {
					if strings.HasSuffix(path, "/sendMessage") {
						return http.StatusBadRequest, `{"ok":false}`
					}
					return http.StatusOK, `{"ok":true}`
				}
			}
			srv := platform.serve(t)
			sender := newFileSender(t, SenderOptions{TelegramBotToken: "T", TelegramBaseURL: srv.URL})
			file := writeShareFile(t, "pdf-bytes")
			accepted, _, err := sender.Send(context.Background(), contact, fileDecision(contact.ContactID, file, tt.caption))
			var partial *contacts.PartialDeliveryError
			if tt.wantPartial != errors.As(err, &partial) || (!tt.wantPartial && err != nil) || !accepted {
				t.Fatalf("Send() = %v, %v", accepted, err)
			}
			if got := platform.paths(); strings.Join(got, ",") != strings.Join(tt.wantPaths, ",") {
				t.Fatalf("requests = %v, want %v", got, tt.wantPaths)
			}
			doc := platform.requests[0]
			if doc.fields["chat_id"] != "42" || doc.fields["caption"] != tt.wantCaption || doc.filename != "weekly-report.pdf" || doc.file != "pdf-bytes" {
				t.Fatalf("sendDocument = %+v", doc)
			}
		})
	}
}

func TestSendTelegramFileKeepsTopic(t *testing.T) {
	platform := &fakePlatform{}
	srv := platform.serve(t)
	sender := newFileSender(t, SenderOptions{TelegramBotToken: "T", TelegramBaseURL: srv.URL})
	contact := contacts.Contact{ContactID: "tg:@ann", Channel: contacts.ChannelTelegram, TGUsername: "ann", TGGroupChatIDs: []int64{-1001}}
	decision := fileDecision(contact.ContactID, writeShareFile(t, "a"), "")
	decision.ChatID = "tg:-1001_7"
	if _, _, err := sender.Send(context.Background(), contact, decision); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if got := platform.requests[0].fields; got["chat_id"] != "-1001" || got["message_thread_id"] != "7" {
		t.Fatalf("fields = %v", got)
	}
}

func TestSendSlackFile(t *testing.T) {
	platform := &fakePlatform{}
	var srv *httptest.Server
	platform.reply = func(path string) (int, string) {
		if path == "/files.getUploadURLExternal" {
			return http.StatusOK, `{"ok":true,"upload_url":"` + srv.URL + `/upload","file_id":"F1"}`
		}
		return http.StatusOK, `{"ok":true}`
	}
	srv = platform.serve(t)
	sender := newFileSender(t, SenderOptions{SlackBotToken: "xoxb", SlackBaseURL: srv.URL})
	contact := contacts.Contact{ContactID: "slack:T1:U1", Channel: contacts.ChannelSlack, SlackTeamID: "T1", SlackUserID: "U1", SlackDMChannelID: "D1"}
	if _, _, err := sender.Send(context.Background(), contact, fileDecision(contact.ContactID, writeShareFile(t, "slack-bytes"), "report")); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	want := []string{"/files.getUploadURLExternal", "/upload", "/files.completeUploadExternal"}
	if got := platform.paths(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("requests = %v", got)
	}
	if platform.requests[0].fields["filename"] != "weekly-report.pdf" || platform.requests[1].file != "slack-bytes" {
		t.Fatalf("upload requests = %+v", platform.requests[:2])
	}
	complete := platform.requests[2].json
	if complete["channel_id"] != "D1" || complete["initial_comment"] != "report" {
		t.Fatalf("complete = %v", complete)
	}
}

func TestSendLarkFile(t *testing.T) {
	platform := &fakePlatform{reply: func(path string) (int, string) {
		switch path {
		case "/auth/v3/tenant_access_token/internal":
			return http.StatusOK, `{"code":0,"tenant_access_token":"tok","expire":7200}`
		case "/im/v1/files":
			return http.StatusOK, `{"code":0,"data":{"file_key":"fk1"}}`
		}
		return http.StatusOK, `{"code":0}`
	}}
	srv := platform.serve(t)
	sender := newFileSender(t, SenderOptions{LarkAppID: "a", LarkAppSecret: "s", LarkBaseURL: srv.URL})
	contact := contacts.Contact{ContactID: "lark_user:ou_1", Channel: contacts.ChannelLark, LarkOpenID: "ou_1"}
	if _, _, err := sender.Send(context.Background(), contact, fileDecision(contact.ContactID, writeShareFile(t, "lark-bytes"), "report")); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	want := []string{"/auth/v3/tenant_access_token/internal", "/im/v1/files", "/im/v1/messages", "/im/v1/messages"}
	if got := platform.paths(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("requests = %v", got)
	}
	upload := platform.requests[1]
	if upload.fields["file_type"] != "stream" || upload.fields["file_name"] != "weekly-report.pdf" || upload.file != "lark-bytes" {
		t.Fatalf("upload = %+v", upload)
	}
	fileMsg, textMsg := platform.requests[2].json, platform.requests[3].json
	if fileMsg["msg_type"] != "file" || fileMsg["receive_id"] != "ou_1" || !strings.Contains(fileMsg["content"].(string), "fk1") {
		t.Fatalf("file message = %v", fileMsg)
	}
	if textMsg["msg_type"] != "text" || !strings.Contains(textMsg["content"].(string), "report") {
		t.Fatalf("caption message = %v", textMsg)
	}
}

func TestSendDiscordFile(t *testing.T) {
	tests := []struct {
		name       string
		caption    string
		wantPaths  int
		wantInFile string
	}{
		{name: "caption attached", caption: "report", wantPaths: 2, wantInFile: "report"},
		{name: "long caption follows", caption: strings.Repeat("x", 2100), wantPaths: 4},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform := &fakePlatform{reply: func(path string) (int, string) {
				if path == "/api/users/@me/channels" {
					return http.StatusOK, `{"id":"900","type":1}`
				}
				return http.StatusOK, `{"id":"1","channel_id":"900"}`
			}}
			srv := platform.serve(t)
			sender := newFileSender(t, SenderOptions{DiscordBotToken: "tok", DiscordBaseURL: srv.URL + "/api"})
			contact := contacts.Contact{ContactID: "discord_user:42", Channel: contacts.ChannelDiscord, DiscordUserID: "42"}
			if _, _, err := sender.Send(context.Background(), contact, fileDecision(contact.ContactID, writeShareFile(t, "discord-bytes"), tt.caption)); err != nil {
				t.Fatalf("Send() error = %v", err)
			}
			if got := platform.paths(); len(got) != tt.wantPaths || got[0] != "/api/users/@me/channels" || got[1] != "/api/channels/900/messages" {
				t.Fatalf("requests = %v", got)
			}
			fileMsg := platform.requests[1]
			var payload map[string]any
			_ = json.Unmarshal([]byte(fileMsg.fields["payload_json"]), &payload)
			content, _ := payload["content"].(string)
			if fileMsg.filename != "weekly-report.pdf" || fileMsg.file != "discord-bytes" || content != tt.wantInFile {
				t.Fatalf("file message = %+v, content %q", fileMsg, content)
			}
		})
	}
}

func TestSendDiscordFileRespectsItsLimit(t *testing.T) {
	sender := newFileSender(t, SenderOptions{DiscordBotToken: "tok", DiscordBaseURL: "http://127.0.0.1:1/api"})
	file := writeShareFile(t, "x")
	if err := os.Truncate(file.Path, discordFileMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	file.Size = discordFileMaxBytes + 1
	contact := contacts.Contact{ContactID: "discord:200", Channel: contacts.ChannelDiscord, DiscordChannelIDs: []string{"200"}}
	_, _, err := sender.Send(context.Background(), contact, fileDecision(contact.ContactID, file, ""))
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("Send() error = %v", err)
	}
}

func TestSendMixinFile(t *testing.T) {
	const conversationID = "8f7059b9-b1b2-4ed8-a99f-4ac2f07a9a34"
	const botID = "773e5e77-4107-45c2-b648-8fc722ed77f5"
	client := &fakeMixinSenderClient{conversation: mixinapi.Conversation{
		ConversationID: conversationID,
		Category:       mixinapi.ConversationCategoryContact,
		Participants:   []mixinapi.ConversationParticipant{{UserID: botID}, {UserID: "0fd3794c-a497-4c5b-8845-c82c9d7814d1"}},
	}}
	sender := &RoutingSender{mixinClient: client, mixinBotID: botID}
	decision := fileDecision("mixin:"+conversationID, writeShareFile(t, "mixin-bytes"), "report")
	if _, _, err := sender.sendMixinFile(context.Background(), mixinSendTarget{ConversationID: conversationID}, decision); err != nil {
		t.Fatalf("sendMixinFile() error = %v", err)
	}
	if len(client.uploads) != 1 || client.uploads[0] != "application/pdf|mixin-bytes" {
		t.Fatalf("uploads = %v", client.uploads)
	}
	if len(client.batches) != 2 {
		t.Fatalf("batches = %d, want file then caption", len(client.batches))
	}
	fileMsg, captionMsg := client.batches[0][0], client.batches[1][0]
	raw, _ := base64.RawURLEncoding.DecodeString(fileMsg.DataBase64)
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if fileMsg.Category != mixinapi.MessageCategoryEncryptedData || data["attachment_id"] != "att-1" || data["name"] != "weekly-report.pdf" {
		t.Fatalf("file message = %+v, data %v", fileMsg, data)
	}
	if captionMsg.Category != mixinapi.MessageCategoryEncryptedText || string(mustDecode(t, captionMsg.DataBase64)) != "report" {
		t.Fatalf("caption message = %+v", captionMsg)
	}
	// The same key gives the same message ID, so Mixin drops a repeated upload message.
	wantID := uuid.NewSHA1(uuid.NewSHA1(uuid.NameSpaceOID, []byte(decision.IdempotencyKey)), []byte(fileMsg.RecipientID)).String()
	if fileMsg.MessageID != wantID {
		t.Fatalf("file message id = %s, want %s from the idempotency key", fileMsg.MessageID, wantID)
	}
}

func TestSendAccountDMFile(t *testing.T) {
	sender := newFileSender(t, SenderOptions{})
	contact := contacts.Contact{ContactID: "wechat_user:u1@im.wechat", Channel: contacts.ChannelWeChat, WeChatUserID: "u1@im.wechat"}
	file := writeShareFile(t, "wa")
	decision := fileDecision(contact.ContactID, file, "report")
	if _, _, err := sender.Send(context.Background(), contact, decision); !errors.Is(err, livesend.ErrNotRunning) {
		t.Fatalf("Send with no WeChat runtime = %v", err)
	}
	live := &liveRecorder{}
	defer livesend.Register("wechat", live)()
	if _, _, err := sender.Send(context.Background(), contact, decision); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if len(live.sent) != 1 || live.sent[0] != "u1@im.wechat|file:"+file.Path+"|weekly-report.pdf|report" {
		t.Fatalf("sent %q", live.sent)
	}
}

func TestSendFileRejections(t *testing.T) {
	platform := &fakePlatform{}
	srv := platform.serve(t)
	sender := newFileSender(t, SenderOptions{TelegramBotToken: "T", TelegramBaseURL: srv.URL, LineChannelToken: "L", LineBaseURL: srv.URL})
	tgContact := contacts.Contact{ContactID: "tg:42", Channel: contacts.ChannelTelegram, TGPrivateChatID: 42}

	t.Run("line is unsupported", func(t *testing.T) {
		contact := contacts.Contact{ContactID: "line_user:U1", Channel: contacts.ChannelLine, LineUserID: "U1"}
		_, _, err := sender.Send(context.Background(), contact, fileDecision(contact.ContactID, writeShareFile(t, "a"), "caption"))
		if err == nil || !strings.Contains(err.Error(), "line does not support file delivery") {
			t.Fatalf("Send() error = %v", err)
		}
	})
	t.Run("file removed", func(t *testing.T) {
		file := writeShareFile(t, "a")
		_ = os.Remove(file.Path)
		_, _, err := sender.Send(context.Background(), tgContact, fileDecision(tgContact.ContactID, file, "caption"))
		if err == nil || !strings.Contains(err.Error(), "no longer exists") {
			t.Fatalf("Send() error = %v", err)
		}
	})
	t.Run("file changed", func(t *testing.T) {
		file := writeShareFile(t, "a")
		if err := os.WriteFile(file.Path, []byte("longer now"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, _, err := sender.Send(context.Background(), tgContact, fileDecision(tgContact.ContactID, file, ""))
		if err == nil || !strings.Contains(err.Error(), "changed") {
			t.Fatalf("Send() error = %v", err)
		}
	})
	t.Run("upload failure sends no caption", func(t *testing.T) {
		platform.reply = func(string) (int, string) { return http.StatusInternalServerError, `{"ok":false}` }
		defer func() { platform.reply = nil }()
		before := len(platform.paths())
		_, _, err := sender.Send(context.Background(), tgContact, fileDecision(tgContact.ContactID, writeShareFile(t, "a"), strings.Repeat("a", 1100)))
		var partial *contacts.PartialDeliveryError
		if err == nil || errors.As(err, &partial) {
			t.Fatalf("Send() error = %v", err)
		}
		if got := platform.paths()[before:]; len(got) != 1 || got[0] != "/botT/sendDocument" {
			t.Fatalf("requests = %v", got)
		}
	})
	if len(platform.paths()) != 1 {
		t.Fatalf("requests = %v, want only the failed upload", platform.paths())
	}
}

func mustDecode(t *testing.T, value string) []byte {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
