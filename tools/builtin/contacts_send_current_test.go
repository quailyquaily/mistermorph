package builtin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

// botAPIRequest is one call a fake Telegram Bot API received.
type botAPIRequest struct {
	method   string
	chatID   string
	caption  string
	text     string
	filename string
	file     string
}

// currentConversationFixture is contacts_send wired to a fake Telegram Bot API, with Alice the
// person of the current direct chat (tg:@alice, private chat 7001), and Bob and Cid in group -1001.
type currentConversationFixture struct {
	tool  *ContactsSendTool
	cache string
	mu    sync.Mutex
	calls []botAPIRequest
}

func newCurrentConversationFixture(t *testing.T) *currentConversationFixture {
	t.Helper()
	now := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	base := t.TempDir()
	contactsDir := filepath.Join(base, "contacts")
	f := &currentConversationFixture{cache: filepath.Join(base, "cache")}
	if err := os.MkdirAll(f.cache, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(f.cache, "report.pdf"), "the report")

	svc := contacts.NewService(contacts.NewStore(contactsDir))
	for _, contact := range []contacts.Contact{
		{ContactID: "tg:@alice", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGUsername: "alice", TGPrivateChatID: 7001},
		{ContactID: "tg:@bob", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGUsername: "bob", TGGroupChatIDs: []int64{-1001}},
		{ContactID: "tg:@cid", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, TGUsername: "cid", TGGroupChatIDs: []int64{-1001}},
	} {
		if _, err := svc.UpsertContact(context.Background(), contact, now); err != nil {
			t.Fatal(err)
		}
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := botAPIRequest{method: r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Errorf("ParseMultipartForm() error = %v", err)
			}
			call.chatID, call.caption = r.FormValue("chat_id"), r.FormValue("caption")
			for _, headers := range r.MultipartForm.File {
				file, _ := headers[0].Open()
				raw, _ := io.ReadAll(file)
				call.filename, call.file = headers[0].Filename, string(raw)
			}
		} else {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			call.chatID, _ = jsonScalar(body["chat_id"])
			call.text, _ = body["text"].(string)
		}
		f.mu.Lock()
		f.calls = append(f.calls, call)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":1}}`)
	}))
	t.Cleanup(srv.Close)

	f.tool = NewContactsSendTool(ContactsSendToolOptions{
		Enabled:          true,
		ContactsDir:      contactsDir,
		TelegramBotToken: "token",
		TelegramBaseURL:  srv.URL,
		FailureCooldown:  time.Hour,
		PathRoots:        pathroots.New("", f.cache, filepath.Join(base, "state")),
	})
	return f
}

func jsonScalar(v any) (string, bool) {
	switch v := v.(type) {
	case string:
		return v, true
	case float64:
		raw, _ := json.Marshal(v)
		return string(raw), true
	default:
		return "", false
	}
}

func (f *currentConversationFixture) delivered() []botAPIRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]botAPIRequest(nil), f.calls...)
}

// directChat is a run answering Alice in her private chat; groupChat is a run answering group -1001.
func directChat() context.Context {
	return WithContactsSendRuntimeContext(context.Background(), ContactsSendRuntimeContext{
		ForbiddenTargetIDs: []string{"tg:@alice", "tg:7001"},
	})
}

func groupChat() context.Context {
	return WithContactsSendRuntimeContext(context.Background(), ContactsSendRuntimeContext{
		ForbiddenTargetIDs: []string{"tg:-1001"},
	})
}

func assertAccepted(t *testing.T, out string) {
	t.Helper()
	if strings.Count(out, `"accepted": true`) == 0 || strings.Contains(out, `"accepted": false`) {
		t.Fatalf("output = %s, want every outcome accepted", out)
	}
}

func TestContactsSendFileToCurrentConversationCounterpart(t *testing.T) {
	// A Telegram contact with a username is always mentioned, so the caption is just the mention.
	t.Run("by username contact_id without message_text", func(t *testing.T) {
		f := newCurrentConversationFixture(t)
		out, err := f.tool.Execute(directChat(), map[string]any{
			"contact_id": "tg:@Alice",
			"path":       "file_cache_dir/report.pdf",
		})
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		assertAccepted(t, out)
		calls := f.delivered()
		if len(calls) != 1 || calls[0].method != "sendDocument" || calls[0].chatID != "7001" || calls[0].file != "the report" || calls[0].filename != "report.pdf" || calls[0].caption != "@alice" {
			t.Fatalf("delivered = %+v, want one report.pdf to chat 7001", calls)
		}
	})

	t.Run("by chat contact_id without caption", func(t *testing.T) {
		f := newCurrentConversationFixture(t)
		out, err := f.tool.Execute(directChat(), map[string]any{
			"contact_id": "tg:7001",
			"path":       "report.pdf",
			"filename":   "weekly.pdf",
		})
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		assertAccepted(t, out)
		calls := f.delivered()
		if len(calls) != 1 || calls[0].method != "sendDocument" || calls[0].chatID != "7001" || calls[0].file != "the report" || calls[0].filename != "weekly.pdf" || calls[0].caption != "" {
			t.Fatalf("delivered = %+v, want one uncaptioned weekly.pdf to chat 7001", calls)
		}
	})

	t.Run("by chat_id with caption", func(t *testing.T) {
		f := newCurrentConversationFixture(t)
		out, err := f.tool.Execute(groupChat(), map[string]any{
			"contact_id":   "tg:@bob",
			"chat_id":      "tg:-1001",
			"path":         "report.pdf",
			"message_text": "The report.",
		})
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		assertAccepted(t, out)
		calls := f.delivered()
		if len(calls) != 1 || calls[0].method != "sendDocument" || calls[0].chatID != "-1001" || calls[0].file != "the report" || calls[0].caption != "@bob The report." {
			t.Fatalf("delivered = %+v, want report.pdf captioned %q to chat -1001", calls, "@bob The report.")
		}
	})

	t.Run("batch including the counterpart", func(t *testing.T) {
		f := newCurrentConversationFixture(t)
		out, err := f.tool.Execute(directChat(), map[string]any{
			"contact_id":   "tg:@bob,tg:@alice",
			"path":         "report.pdf",
			"message_text": "The report.",
		})
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		assertAccepted(t, out)
		chats := map[string]string{}
		for _, call := range f.delivered() {
			if call.method != "sendDocument" || call.file != "the report" {
				t.Fatalf("delivered %+v, want only the report as a document", call)
			}
			chats[call.chatID] = call.caption
		}
		if len(chats) != 2 || chats["7001"] != "The report." || chats["-1001"] != "@bob The report." {
			t.Fatalf("captions by chat = %v, want Alice's private chat and Bob's group", chats)
		}
	})

	t.Run("batch to the current chat by chat_id", func(t *testing.T) {
		f := newCurrentConversationFixture(t)
		out, err := f.tool.Execute(groupChat(), map[string]any{
			"contact_id": "tg:@bob,tg:@cid",
			"chat_id":    "tg:-1001",
			"path":       "report.pdf",
		})
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		assertAccepted(t, out)
		calls := f.delivered()
		if len(calls) != 1 || calls[0].method != "sendDocument" || calls[0].chatID != "-1001" || calls[0].caption != "@bob @cid" {
			t.Fatalf("delivered = %+v, want one document to -1001 mentioning both", calls)
		}
	})
}

func TestContactsSendTextToCurrentConversationCounterpartStaysBlocked(t *testing.T) {
	envelope, _ := json.Marshal(map[string]any{"message_id": "m1", "text": "hi", "sent_at": "2026-11-24T09:00:00Z"})
	for _, tc := range []struct {
		name   string
		ctx    context.Context
		params map[string]any
		field  string
	}{
		{name: "text by contact_id", ctx: directChat(), params: map[string]any{"contact_id": "tg:@alice", "message_text": "hi"}, field: `contact_id "tg:@alice"`},
		{name: "base64 by contact_id", ctx: directChat(), params: map[string]any{"contact_id": "tg:7001", "message_base64": base64.RawURLEncoding.EncodeToString(envelope)}, field: `contact_id "tg:7001"`},
		{name: "text by chat_id", ctx: groupChat(), params: map[string]any{"contact_id": "tg:@bob", "chat_id": "tg:-1001", "message_text": "hi"}, field: `chat_id "tg:-1001"`},
		{name: "text in a batch", ctx: directChat(), params: map[string]any{"contact_id": "tg:@bob,tg:@alice", "message_text": "hi"}, field: `contact_id "tg:@alice"`},
		{name: "batch text by chat_id", ctx: groupChat(), params: map[string]any{"contact_id": "tg:@bob,tg:@cid", "chat_id": "tg:-1001", "message_text": "hi"}, field: `chat_id "tg:-1001"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCurrentConversationFixture(t)
			_, err := f.tool.Execute(tc.ctx, tc.params)
			if err == nil {
				t.Fatal("Execute() sent a text message to the current conversation")
			}
			for _, want := range []string{"contacts_send blocked: " + tc.field + " matches current conversation counterpart", "answer in this conversation", "pass path to send them a file"} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error = %q, want it to contain %q", err.Error(), want)
				}
			}
			if calls := f.delivered(); len(calls) != 0 {
				t.Fatalf("delivered %+v", calls)
			}
		})
	}
}

// A path that does not give a file never lets a message through to the current conversation.
func TestContactsSendInvalidFileToCurrentConversationSendsNothing(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params map[string]any
		want   string
	}{
		{name: "empty path", params: map[string]any{"contact_id": "tg:@alice", "path": "  ", "message_text": "hi"}, want: "path must not be empty"},
		{name: "missing file", params: map[string]any{"contact_id": "tg:@alice", "path": "nope.pdf", "message_text": "hi"}, want: "nope.pdf"},
		{name: "path with base64", params: map[string]any{"contact_id": "tg:@alice", "path": "report.pdf", "message_base64": "e30"}, want: "cannot be combined with message_base64"},
		{name: "non-string path", params: map[string]any{"contact_id": "tg:@alice", "path": 3, "message_text": "hi"}, want: "path"},
		{name: "missing file in a batch", params: map[string]any{"contact_id": "tg:@bob,tg:@alice", "path": "nope.pdf", "message_text": "hi"}, want: "nope.pdf"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCurrentConversationFixture(t)
			_, err := f.tool.Execute(directChat(), tc.params)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want one about %q", err, tc.want)
			}
			if calls := f.delivered(); len(calls) != 0 {
				t.Fatalf("delivered %+v", calls)
			}
		})
	}
}

func TestContactsSendDescriptionAllowsFilesToCurrentUser(t *testing.T) {
	desc := NewContactsSendTool(ContactsSendToolOptions{}).Description()
	for _, want := range []string{"NEVER send a text message to the person who is talking with you", "A file (path, caption optional) may be sent to the person talking with you"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("description lacks %q:\n%s", want, desc)
		}
	}
}
