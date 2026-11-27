package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/consoleuser"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/solo"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// useConsoleUserConfig makes configPath the Console's config for the test.
func useConsoleUserConfig(t *testing.T, configPath string) {
	t.Helper()
	prevConfig, hadConfig := viper.Get("config"), viper.IsSet("config")
	viper.Set("config", configPath)
	t.Cleanup(func() {
		if hadConfig {
			viper.Set("config", prevConfig)
		} else {
			viper.Set("config", nil)
		}
	})
}

func consoleUserYAMLConfig(t *testing.T, content string) string {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	useConsoleUserConfig(t, configPath)
	return configPath
}

type consoleUserMe struct {
	Authenticated bool   `json:"authenticated"`
	Account       string `json:"account"`
	UserName      string `json:"user_name"`
	DisplayName   string `json:"display_name"`
}

func readConsoleUserMe(t *testing.T, srv *server) consoleUserMe {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.handleAuthMe(rec, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /auth/me = %d: %s", rec.Code, rec.Body.String())
	}
	var me consoleUserMe
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if !me.Authenticated || me.Account != "console" {
		t.Fatalf("/auth/me = %+v, want the fixed console account", me)
	}
	return me
}

// putConsoleUserName saves name as the Setup page does: one config change and nothing else.
func putConsoleUserName(srv *server, name string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]any{"config_changes": map[string]any{consoleuser.ConfigKey: name}})
	rec := httptest.NewRecorder()
	srv.handleConsoleSettings(rec, httptest.NewRequest(http.MethodPut, "/api/settings/console", strings.NewReader(string(body))))
	return rec
}

func mustPutConsoleUserName(t *testing.T, srv *server, name string) {
	t.Helper()
	if rec := putConsoleUserName(srv, name); rec.Code != http.StatusOK {
		t.Fatalf("save %q = %d: %s", name, rec.Code, rec.Body.String())
	}
}

func TestConsoleUserNameWriteValidation(t *testing.T) {
	eighty := strings.Repeat("名", consoleuser.MaxNameLength)
	const prior = "Prior Name"
	cases := []struct {
		name  string
		in    string
		saved string // "" when the write must be refused
	}{
		{name: "plain", in: "Lyra", saved: "Lyra"},
		{name: "surrounding space is dropped", in: "  Lyra\t", saved: "Lyra"},
		{name: "surrounding unicode space is dropped", in: "\u3000\u00a0Lyra\u2003\ufeff", saved: "Lyra"},
		{name: "internal spaces stay", in: "Ada  Lovelace", saved: "Ada  Lovelace"},
		{name: "cjk and emoji", in: " 小明 🙂👩‍💻 ", saved: "小明 🙂👩‍💻"},
		{name: "markup is text", in: "<img src=x onerror=alert(1)> **bold** `code`", saved: "<img src=x onerror=alert(1)> **bold** `code`"},
		{name: "80 code points", in: eighty, saved: eighty},
		{name: "81 code points", in: eighty + "名"},
		{name: "empty", in: ""},
		{name: "spaces only", in: "   "},
		{name: "unicode spaces only", in: "\u3000\u00a0\u2003\u2028"},
		{name: "line feed", in: "Ada\nLovelace"},
		{name: "carriage return", in: "Ada\rLovelace"},
		{name: "line separator", in: "Ada\u2028Lovelace"},
		{name: "tab", in: "Ada\tLovelace"},
		{name: "nul", in: "Ada\x00Lovelace"},
		{name: "escape", in: "Ada\x1b[0m"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			configPath := consoleUserYAMLConfig(t, "console:\n  user_name: "+prior+"\n")
			srv := &server{}
			rec := putConsoleUserName(srv, tc.in)
			me := readConsoleUserMe(t, srv)
			if tc.saved == "" {
				if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), consoleuser.ConfigKey) {
					t.Fatalf("save %q = %d: %s, want 400 naming the field", tc.in, rec.Code, rec.Body.String())
				}
				if me.UserName != prior || me.DisplayName != prior {
					t.Fatalf("after a refused save /auth/me = %+v, want the prior name", me)
				}
				raw, _ := os.ReadFile(configPath)
				if string(raw) != "console:\n  user_name: "+prior+"\n" {
					t.Fatalf("a refused save changed the config:\n%s", raw)
				}
				return
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("save %q = %d: %s", tc.in, rec.Code, rec.Body.String())
			}
			var saved struct {
				ConfigValues map[string]any `json:"config_values"`
				ApplyMode    string         `json:"apply_mode"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
				t.Fatal(err)
			}
			if saved.ConfigValues[consoleuser.ConfigKey] != tc.saved || saved.ApplyMode != "immediate" {
				t.Fatalf("save answered %#v (%s), want %q applied at once", saved.ConfigValues[consoleuser.ConfigKey], saved.ApplyMode, tc.saved)
			}
			if me.UserName != tc.saved || me.DisplayName != tc.saved {
				t.Fatalf("/auth/me = %+v, want %q", me, tc.saved)
			}
			// Saving the same name again changes nothing.
			mustPutConsoleUserName(t, srv, tc.saved)
			if again := readConsoleUserMe(t, srv); again.UserName != tc.saved {
				t.Fatalf("after saving it again /auth/me = %+v", again)
			}
		})
	}
}

func TestConsoleUserNameRejectsNonStringWrites(t *testing.T) {
	consoleUserYAMLConfig(t, "console:\n  user_name: Prior\n")
	srv := &server{}
	for _, raw := range []string{`null`, `12`, `["a"]`, `{"name":"a"}`, `true`} {
		rec := httptest.NewRecorder()
		body := `{"config_changes":{"console.user_name":` + raw + `}}`
		srv.handleConsoleSettings(rec, httptest.NewRequest(http.MethodPut, "/api/settings/console", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("save %s = %d, want 400", raw, rec.Code)
		}
	}
	if me := readConsoleUserMe(t, srv); me.UserName != "Prior" {
		t.Fatalf("/auth/me = %+v, want the prior name", me)
	}
}

// Without a saved name the Console's human keeps the old name, and nothing is saved by reading.
func TestConsoleUserNameFallsBackWithoutASavedName(t *testing.T) {
	for name, content := range map[string]string{
		"no config":     "",
		"other keys":    "console:\n  listen: 127.0.0.1:9080\n",
		"blank":         "console:\n  user_name: \"   \"\n",
		"not a name":    "console:\n  user_name: \"a\\nb\"\n",
		"overlong name": "console:\n  user_name: " + strings.Repeat("x", consoleuser.MaxNameLength+1) + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			configPath := consoleUserYAMLConfig(t, content)
			srv := &server{}
			me := readConsoleUserMe(t, srv)
			if me.UserName != "" || me.DisplayName != consoleuser.DefaultDisplayName {
				t.Fatalf("/auth/me = %+v, want no saved name and the default shown", me)
			}
			if got := srv.userName.displayName(); got != consoleuser.DefaultDisplayName {
				t.Fatalf("displayName() = %q", got)
			}
			raw, _ := os.ReadFile(configPath)
			if string(raw) != content {
				t.Fatalf("reading changed the config:\n%s", raw)
			}
		})
	}
	t.Run("missing config file", func(t *testing.T) {
		useConsoleUserConfig(t, filepath.Join(t.TempDir(), "absent.yaml"))
		if me := readConsoleUserMe(t, &server{}); me.UserName != "" || me.DisplayName != consoleuser.DefaultDisplayName {
			t.Fatalf("/auth/me = %+v", me)
		}
	})
}

// A save of the name alone changes that one key: the password, the channels, the managed
// runtimes, the endpoints and keys this version does not know stay as they were, and so do the
// agent's persona files beside the config.
func TestConsoleUserNameSaveLeavesEverythingElseAlone(t *testing.T) {
	const initial = `# my console
llm:
  provider: openai
  api_key: sk-keep
console:
  listen: 127.0.0.1:9191
  password_hash: "$2a$10$abcdefghijklmnopqrstuv"
  managed_runtimes: [telegram]
  endpoints:
    - name: Remote
      url: http://127.0.0.1:9999
      auth_token: remote-token
telegram:
  bot_token: tg-keep
unknown_key: stays
`
	configPath := consoleUserYAMLConfig(t, initial)
	dir := filepath.Dir(configPath)
	persona := map[string]string{
		"IDENTITY.md":   "# IDENTITY.md\n\n- **Name:** Morph\n",
		"identity.yaml": "name: Morph\nname_alts: [Morphy]\n",
		"SOUL.md":       "# soul.md\n\nBe kind.\n",
	}
	for name, content := range persona {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	srv := &server{}
	mustPutConsoleUserName(t, srv, "  小明  ")

	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	sawName := false
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "user_name: 小明" {
			sawName = true
			continue
		}
		kept = append(kept, line)
	}
	if !sawName {
		t.Fatalf("the name is not in the config:\n%s", raw)
	}
	if got := strings.Join(kept, "\n"); got != initial {
		t.Fatalf("the save changed more than the name:\n%s\nwant\n%s", got, initial)
	}
	for name, content := range persona {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(got) != content {
			t.Fatalf("%s = %q, %v; want it untouched", name, got, err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if _, known := persona[entry.Name()]; !known && entry.Name() != "config.yaml" {
			t.Errorf("the save wrote %s", entry.Name())
		}
	}
	if me := readConsoleUserMe(t, srv); me.Account != "console" || me.UserName != "小明" {
		t.Fatalf("/auth/me = %+v, want the account unchanged and the name saved", me)
	}
}

// The name is behind the Console's session like every other setting; every signed-in client reads
// the same one, and it outlives the sessions.
func TestConsoleUserNameNeedsASessionAndIsSharedByClients(t *testing.T) {
	configPath := consoleUserYAMLConfig(t, "console:\n  user_name: Prior\n")
	verifier, err := newPasswordVerifier("secret", "")
	if err != nil {
		t.Fatal(err)
	}
	srv := &server{
		cfg:      serveConfig{password: "secret", sessionTTL: time.Hour},
		password: verifier,
		sessions: newSessionStore(""),
	}
	do := func(token, method, path, body string) *httptest.ResponseRecorder {
		handler := srv.withAuth(srv.handleAuthMe)
		if path == "/api/settings/console" {
			handler = srv.withAuth(srv.handleConsoleSettings)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		handler(rec, req)
		return rec
	}
	const write = `{"config_changes":{"console.user_name":"Intruder"}}`
	for _, token := range []string{"", "not-a-session"} {
		if rec := do(token, http.MethodPut, "/api/settings/console", write); rec.Code != http.StatusUnauthorized {
			t.Fatalf("write with token %q = %d, want 401", token, rec.Code)
		}
		if rec := do(token, http.MethodGet, "/api/auth/me", ""); rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "Prior") {
			t.Fatalf("read with token %q = %d: %s, want 401 without the name", token, rec.Code, rec.Body.String())
		}
	}
	if raw, _ := os.ReadFile(configPath); string(raw) != "console:\n  user_name: Prior\n" {
		t.Fatalf("an unauthenticated write changed the config:\n%s", raw)
	}

	first, _, err := srv.sessions.Create(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := srv.sessions.Create(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if rec := do(first, http.MethodPut, "/api/settings/console", `{"config_changes":{"console.user_name":" 山田 太郎 🎌 "}}`); rec.Code != http.StatusOK {
		t.Fatalf("signed-in write = %d: %s", rec.Code, rec.Body.String())
	}
	readName := func(token string) string {
		rec := do(token, http.MethodGet, "/api/auth/me", "")
		var me consoleUserMe
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &me) != nil {
			t.Fatalf("read = %d: %s", rec.Code, rec.Body.String())
		}
		if me.Account != "console" {
			t.Fatalf("account = %q, want console", me.Account)
		}
		return me.UserName
	}
	for _, token := range []string{first, second} {
		if got := readName(token); got != "山田 太郎 🎌" {
			t.Fatalf("a signed-in client reads %q", got)
		}
	}
	// Logging out and in again: the name is the Console's, not the session's.
	srv.sessions.Delete(first)
	if rec := do(first, http.MethodGet, "/api/auth/me", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("read after logout = %d, want 401", rec.Code)
	}
	third, _, err := srv.sessions.Create(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := readName(third); got != "山田 太郎 🎌" {
		t.Fatalf("after logging in again the name is %q", got)
	}
}

// A saved name is in the config, in agent.db or in a file, so a Console started again has it.
func TestConsoleUserNamePersistsAcrossRestart(t *testing.T) {
	for kind, configPath := range map[string]string{
		"agent.db": configstore.DBConfigPath(t.TempDir()),
		"file":     filepath.Join(t.TempDir(), "config.yaml"),
	} {
		t.Run(kind, func(t *testing.T) {
			useConsoleUserConfig(t, configPath)
			before := &server{}
			if me := readConsoleUserMe(t, before); me.UserName != "" {
				t.Fatalf("a new Console has the name %q", me.UserName)
			}
			mustPutConsoleUserName(t, before, " 小明 🙂 ")

			after := &server{}
			me := readConsoleUserMe(t, after)
			if me.UserName != "小明 🙂" || me.DisplayName != "小明 🙂" {
				t.Fatalf("after a restart /auth/me = %+v", me)
			}
			if got := after.userName.displayName(); got != "小明 🙂" {
				t.Fatalf("after a restart new tasks would record %q", got)
			}
			raw, err := configstore.ReadFile(configPath)
			var stored struct {
				Console struct {
					UserName string `yaml:"user_name"`
				} `yaml:"console"`
			}
			if err != nil || yaml.Unmarshal(raw, &stored) != nil || stored.Console.UserName != "小明 🙂" {
				t.Fatalf("stored config = %q, %v", raw, err)
			}
			// A later change is read at once by a Console that already read the old name.
			mustPutConsoleUserName(t, before, "Ming")
			if got := after.userName.displayName(); got != "Ming" {
				t.Fatalf("the other server still records %q", got)
			}
		})
	}
}

// MISTER_MORPH_CONSOLE_USER_NAME names the user like any config key's variable, and then the
// Console cannot change it.
func TestConsoleUserNameFromEnvironmentIsNotEditable(t *testing.T) {
	configPath := consoleUserYAMLConfig(t, "console:\n  user_name: Saved\n")
	t.Setenv("MISTER_MORPH_CONSOLE_USER_NAME", "  From Env  ")
	srv := &server{}
	if me := readConsoleUserMe(t, srv); me.UserName != "From Env" {
		t.Fatalf("/auth/me = %+v, want the environment's name", me)
	}
	if rec := putConsoleUserName(srv, "Other"); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "MISTER_MORPH_CONSOLE_USER_NAME") {
		t.Fatalf("save = %d: %s, want it refused as managed by the variable", rec.Code, rec.Body.String())
	}
	if raw, _ := os.ReadFile(configPath); string(raw) != "console:\n  user_name: Saved\n" {
		t.Fatalf("config changed:\n%s", raw)
	}
}

func consoleUserParticipant(t *testing.T, task daemonruntime.TaskInfo) string {
	t.Helper()
	if task.Conversation == nil || len(task.Conversation.Participants) != 1 {
		t.Fatalf("task %s conversation = %+v, want the one Console participant", task.ID, task.Conversation)
	}
	participant := task.Conversation.Participants[0]
	if participant.ID != "console:user" {
		t.Fatalf("task %s participant id = %q, want console:user", task.ID, participant.ID)
	}
	return participant.Nickname
}

// promptFor is the model request of the run whose newest message has marker.
func (h soloHarness) promptFor(t *testing.T, marker string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, raw := range h.provider.snapshot() {
			var messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			}
			if json.Unmarshal([]byte(raw), &messages) != nil || len(messages) == 0 {
				continue
			}
			for i := len(messages) - 1; i >= 0; i-- {
				if messages[i].Role != "user" {
					continue
				}
				if strings.Contains(messages[i].Content, marker) && strings.Contains(messages[i].Content, "current_message") {
					return raw
				}
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no model request for %q", marker)
	return ""
}

func (h soloHarness) consoleContactNickname(t *testing.T) string {
	t.Helper()
	generation, err := h.rt.captureGeneration()
	if err != nil {
		t.Fatal(err)
	}
	defer generation.release()
	contact, ok, err := generation.contactsSvc.GetContact(context.Background(), consoleParticipantKey)
	if err != nil || !ok {
		t.Fatalf("console contact: found=%v err=%v", ok, err)
	}
	return contact.ContactNickname
}

// New tasks, in an ordinary topic and in Solo, record the name saved when they are sent: on the
// task's conversation, on the inbound message (the contact it makes) and in what the model reads.
// Tasks from before keep the name they recorded, also after a restart.
func TestConsoleTasksRecordTheSavedUserName(t *testing.T) {
	consoleUserYAMLConfig(t, "")
	stateDir, cacheDir, soloWS := t.TempDir(), t.TempDir(), t.TempDir()
	h := newSoloHarnessAt(t, stateDir, cacheDir, soloWS)
	srv := &server{}
	h.rt.userDisplayName = srv.userName.displayName
	const saved = "小明 🙂"
	nicknameJSON := func(name string) string {
		// The model reads the sender as JSON inside a message's text.
		quoted, _ := json.Marshal(name)
		return `"nickname": ` + string(quoted)
	}
	promptHas := func(prompt, name string) bool {
		var messages []struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal([]byte(prompt), &messages); err != nil {
			t.Fatal(err)
		}
		for _, message := range messages {
			if strings.Contains(message.Content, nicknameJSON(name)) {
				return true
			}
		}
		return false
	}

	// Before a name is saved: the old name, as on an installation from before this setting.
	legacy := h.chat("", "legacy-hello one")
	legacyDone := h.client.wait(legacy.ID, daemonruntime.TaskDone)
	if got := consoleUserParticipant(t, legacyDone); got != consoleuser.DefaultDisplayName {
		t.Fatalf("task without a saved name records %q", got)
	}
	if prompt := h.promptFor(t, "legacy-hello one"); !promptHas(prompt, consoleuser.DefaultDisplayName) {
		t.Fatalf("the model did not read the default name:\n%s", prompt)
	}
	if got := h.consoleContactNickname(t); got != consoleuser.DefaultDisplayName {
		t.Fatalf("console contact = %q", got)
	}

	// Saved: the next message in the same topic carries it, with no restart or reload.
	mustPutConsoleUserName(t, srv, "  "+saved+" ")
	named := h.chat(legacy.TopicID, "named-hello two")
	namedDone := h.client.wait(named.ID, daemonruntime.TaskDone)
	if got := consoleUserParticipant(t, namedDone); got != saved {
		t.Fatalf("task after the save records %q, want %q", got, saved)
	}
	prompt := h.promptFor(t, "named-hello two")
	if !promptHas(prompt, saved) {
		t.Fatalf("the model did not read the saved name for the new message:\n%s", prompt)
	}
	// The earlier message is history under the name it was sent with.
	if !promptHas(prompt, consoleuser.DefaultDisplayName) || !strings.Contains(prompt, "legacy-hello one") {
		t.Fatalf("the earlier message lost its recorded name:\n%s", prompt)
	}
	if strings.Contains(prompt, `\"username\": \"`+saved) || !strings.Contains(prompt, `\"username\": \"console\"`) || !strings.Contains(prompt, `console:user`) {
		t.Fatalf("the stable identifiers changed:\n%s", prompt)
	}
	if got := h.consoleContactNickname(t); got != saved {
		t.Fatalf("console contact after the save = %q, want %q", got, saved)
	}
	var legacyStored daemonruntime.TaskInfo
	h.client.ok("GET", "/tasks/"+legacy.ID, nil, &legacyStored)
	if got := consoleUserParticipant(t, legacyStored); got != consoleuser.DefaultDisplayName {
		t.Fatalf("the earlier task was renamed to %q", got)
	}

	// Solo: its own message, the work thread it starts, and the thread's card.
	project := t.TempDir()
	dispatch := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-dispatch "+project+" please build the report")
	dispatchDone := h.client.wait(dispatch.ID, daemonruntime.TaskDone)
	if got := consoleUserParticipant(t, dispatchDone); got != saved {
		t.Fatalf("Solo task records %q, want %q", got, saved)
	}
	if soloPrompt := h.promptFor(t, "solo-dispatch"); !promptHas(soloPrompt, saved) {
		t.Fatalf("Solo's model did not read the saved name:\n%s", soloPrompt)
	}
	select {
	case <-h.provider.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the thread's task did not reach the model")
	}
	var card daemonruntime.TaskInfo
	for _, task := range h.soloTasks() {
		if strings.HasPrefix(task.ID, daemonruntime.SoloThreadCardPrefix) {
			card = task
		}
	}
	rec, ok := solo.ThreadOf(card)
	if !ok {
		t.Fatalf("no thread card: %+v", card)
	}
	if got := consoleUserParticipant(t, card); got != saved {
		t.Fatalf("Solo card records %q, want %q", got, saved)
	}
	thread := h.client.wait(rec.TaskID, daemonruntime.TaskRunning)
	if got := consoleUserParticipant(t, thread); got != saved {
		t.Fatalf("work thread task records %q, want %q", got, saved)
	}
	if threadPrompt := h.promptFor(t, "thread-block"); !promptHas(threadPrompt, saved) {
		t.Fatalf("the work thread's model did not read the saved name:\n%s", threadPrompt)
	}

	// A new name: Solo's next message has it, and its history keeps the earlier one.
	const renamed = "Ming <b>the</b> 2nd"
	mustPutConsoleUserName(t, srv, renamed)
	again := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-again three")
	againDone := h.client.wait(again.ID, daemonruntime.TaskDone)
	if got := consoleUserParticipant(t, againDone); got != renamed {
		t.Fatalf("Solo task after the rename records %q", got)
	}
	againPrompt := h.promptFor(t, "solo-again three")
	if !promptHas(againPrompt, renamed) || !promptHas(againPrompt, saved) {
		t.Fatalf("Solo's history does not have both names:\n%s", againPrompt)
	}
	close(h.provider.release)
	h.client.wait(rec.TaskID, daemonruntime.TaskDone)
	h.waitRecord(t, daemonruntime.SoloThreadSummaryID(rec.TaskID), daemonruntime.SoloThreadDone)
	h.rt.soloSyncs.Wait()
	var summary daemonruntime.TaskInfo
	h.client.ok("GET", "/tasks/"+daemonruntime.SoloThreadSummaryID(rec.TaskID), nil, &summary)
	if got := consoleUserParticipant(t, summary); got != renamed {
		t.Fatalf("Solo summary records %q, want the name at the time %q", got, renamed)
	}

	// Restart: a new runtime on the same state and a server that reads the config afresh.
	h.rt.Close()
	h.rt.soloSyncs.Wait()
	restarted := newSoloHarnessAt(t, stateDir, cacheDir, soloWS)
	restartedSrv := &server{}
	restarted.rt.userDisplayName = restartedSrv.userName.displayName
	if me := readConsoleUserMe(t, restartedSrv); me.UserName != renamed {
		t.Fatalf("after a restart /auth/me = %+v", me)
	}
	for id, want := range map[string]string{
		legacy.ID:   consoleuser.DefaultDisplayName,
		named.ID:    saved,
		dispatch.ID: saved,
		rec.TaskID:  saved,
		card.ID:     saved,
		again.ID:    renamed,
	} {
		var task daemonruntime.TaskInfo
		restarted.client.ok("GET", "/tasks/"+id, nil, &task)
		if got := consoleUserParticipant(t, task); got != want {
			t.Errorf("after a restart task %s records %q, want %q", id, got, want)
		}
	}
	later := restarted.chat(legacy.TopicID, "later-hello four")
	if got := consoleUserParticipant(t, restarted.client.wait(later.ID, daemonruntime.TaskDone)); got != renamed {
		t.Fatalf("task after a restart records %q, want %q", got, renamed)
	}
	laterPrompt := restarted.promptFor(t, "later-hello four")
	for _, name := range []string{consoleuser.DefaultDisplayName, saved, renamed} {
		if !promptHas(laterPrompt, name) {
			t.Errorf("after a restart the topic's history lacks %q:\n%s", name, laterPrompt)
		}
	}
}

// The inbound bus message of a task names its sender as the task recorded them, with the stable
// identifiers beside the name.
func TestConsoleInboundCarriesTheTasksUserName(t *testing.T) {
	for _, tc := range []struct{ recorded, want string }{
		{"小明 🙂", "小明 🙂"},
		{"", consoleuser.DefaultDisplayName},
		{"   ", consoleuser.DefaultDisplayName},
	} {
		t.Run(fmt.Sprintf("%q", tc.recorded), func(t *testing.T) {
			bus, err := busruntime.NewInproc(busruntime.InprocOptions{MaxInFlight: 1, Logger: slog.Default()})
			if err != nil {
				t.Fatal(err)
			}
			defer bus.Close()
			got := make(chan busruntime.BusMessage, 1)
			if err := bus.Subscribe(busruntime.TopicChatMessage, func(_ context.Context, msg busruntime.BusMessage) error {
				got <- msg
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			rt := &consoleLocalRuntime{bus: bus}
			job := consoleLocalTaskJob{TaskID: "task_1", TopicID: "topic_1", ConversationKey: buildConsoleConversationKey("topic_1"), Task: "hello", CreatedAt: time.Now(), UserDisplayName: tc.recorded}
			if err := rt.publishConsoleInbound(context.Background(), job); err != nil {
				t.Fatal(err)
			}
			select {
			case msg := <-got:
				ext := msg.Extensions
				if ext.FromDisplayName != tc.want || ext.FromUsername != "console" || ext.FromUserRef != "console:user" || msg.ParticipantKey != "console:user" {
					t.Fatalf("inbound = %+v participant %q, want name %q and the fixed identifiers", ext, msg.ParticipantKey, tc.want)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("no inbound message")
			}
		})
	}
}

// A task read back from the store (after a restart, or approved later) runs under the name it
// recorded, not the one saved since.
func TestConsoleUserNameOfConversation(t *testing.T) {
	rt := &consoleLocalRuntime{userDisplayName: func() string { return "  Now  " }}
	if got := rt.consoleUserDisplayName(); got != "Now" {
		t.Fatalf("consoleUserDisplayName() = %q", got)
	}
	if got := (&consoleLocalRuntime{}).consoleUserDisplayName(); got != consoleuser.DefaultDisplayName {
		t.Fatalf("without a source = %q", got)
	}
	if got := (&consoleLocalRuntime{userDisplayName: func() string { return "" }}).consoleUserDisplayName(); got != consoleuser.DefaultDisplayName {
		t.Fatalf("with an empty source = %q", got)
	}
	card := soloRecordInfo("solothread_x", daemonruntime.SoloThread{}, "text", time.Now(), "Then")
	if got := consoleUserNameOfConversation(card.Conversation); got != "Then" {
		t.Fatalf("recorded name = %q", got)
	}
	if got := consoleUserNameOfConversation(nil); got != "" {
		t.Fatalf("no conversation = %q", got)
	}
	item := newConsoleInboundHistoryItem(consoleLocalTaskJob{TaskID: "t", TopicID: "topic", Task: "hi", UserDisplayName: "Then"})
	if item.Sender.Nickname != "Then" || item.Sender.UserID != "console:user" || item.Sender.Username != "console" || item.Sender.DisplayRef != "console:user" {
		t.Fatalf("current message sender = %+v", item.Sender)
	}
	if legacy := newConsoleInboundHistoryItem(consoleLocalTaskJob{TaskID: "t", Task: "hi"}); legacy.Sender.Nickname != consoleuser.DefaultDisplayName {
		t.Fatalf("sender of a job without a name = %+v", legacy.Sender)
	}
}
