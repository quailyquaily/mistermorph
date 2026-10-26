package chatcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate/seal"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/spf13/viper"
)

func testIdentity(t *testing.T, fill byte) *seal.Identity {
	t.Helper()
	identity, err := seal.NewIdentity(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return identity
}

func TestRemoteStreamFrameParsesQuestionsAndElevations(t *testing.T) {
	raw := `{"task_id":"t","seq":3,"questions":[{"id":"q1","text":"Which?","options":[{"label":"A","description":"first"},{"label":"B"}],"status":"answered","answer":"B","option":1}],
	"elevations":[{"id":"el_1","command":"apt-get update","cwd":"/srv","host":"box","deadline":1793000000,"attempt":2,"status":"open","web_insecure":"warn","offer":{"v":1,"server_pub":"sp","identity":"id","signature":"sig"}}]}`
	var f remoteStreamFrame
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatal(err)
	}
	q, e := f.Questions[0], f.Elevations[0]
	if q.ID != "q1" || q.Text != "Which?" || len(q.Options) != 2 || q.Options[0].Description != "first" || q.Status != "answered" || q.Answer != "B" || q.Option == nil || *q.Option != 1 {
		t.Fatalf("question = %+v", q)
	}
	if e.ID != "el_1" || e.Command != "apt-get update" || e.Cwd != "/srv" || e.Host != "box" || e.Deadline != 1793000000 || e.Attempt != 2 || e.Status != "open" || e.Offer == nil || e.Offer.Version != 1 || e.Offer.ServerPub != "sp" || e.Offer.Identity != "id" || e.Offer.Signature != "sig" {
		t.Fatalf("elevation = %+v", e)
	}
}

func TestRemoteSubmitMarksTheTaskAsSentFromChat(t *testing.T) {
	got := make(chan daemonruntime.SubmitTaskRequest, 1)
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		var req daemonruntime.SubmitTaskRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		got <- req
		_ = json.NewEncoder(w).Encode(daemonruntime.SubmitTaskResponse{ID: "t", TopicID: "a"})
	})
	remoteSubmissionResult(t, m.submit("hello"))
	req := <-got
	if req.Trigger == nil || req.Trigger.Source != "ui" || req.Trigger.Event != "chat_submit" || req.Trigger.Ref != "cli/chat" {
		t.Fatalf("trigger = %+v", req.Trigger)
	}
}

// fakeElevationRuntime plays a Console runtime with one task, "t", whose stream shows an open
// approval sealed by identity, and which opens the answers chat sends.
type fakeElevationRuntime struct {
	t        *testing.T
	identity *seal.Identity
	binding  seal.Binding
	offer    seal.Offer
	opener   *seal.Opener
	refuse   string

	mu        sync.Mutex
	passwords []string
	declines  int
	bodies    []string
}

func newFakeElevationRuntime(t *testing.T, identity *seal.Identity) *fakeElevationRuntime {
	f := &fakeElevationRuntime{t: t, identity: identity, binding: seal.Binding{
		ElevationID: "el_1",
		TaskID:      "t",
		Command:     "systemctl restart nginx",
		Dir:         "/etc/nginx",
		Deadline:    time.Unix(time.Now().Add(2*time.Minute).Unix(), 0),
	}}
	opener, offer, err := identity.Offer(f.binding)
	if err != nil {
		t.Fatal(err)
	}
	f.opener, f.offer = opener, offer
	return f
}

func (f *fakeElevationRuntime) frame() remoteStreamFrame {
	offer := f.offer
	return remoteStreamFrame{TaskID: "t", Seq: 1, Elevations: []remoteElevation{{
		ID: f.binding.ElevationID, Command: f.binding.Command, Cwd: f.binding.Dir, Host: "build-box",
		Deadline: f.binding.Deadline.Unix(), Status: "open", Offer: &offer,
	}}}
}

func (f *fakeElevationRuntime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/runtime/stream/ws":
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			f.t.Error(err)
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(f.frame())
		_, _, _ = conn.ReadMessage()
	case r.Method == http.MethodPost && r.URL.Path == "/runtime/tasks/t/elevation":
		var body bytes.Buffer
		_, _ = body.ReadFrom(r.Body)
		var req daemonruntime.AnswerElevationRequest
		if err := json.Unmarshal(body.Bytes(), &req); err != nil || req.ElevationID != "el_1" || req.Client != "chat" {
			f.t.Errorf("answer = %+v, %v", req, err)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.bodies = append(f.bodies, body.String())
		if f.refuse != "" {
			http.Error(w, f.refuse, http.StatusBadRequest)
			return
		}
		if req.Decline {
			f.declines++
		} else {
			password, err := f.opener.Open(req.Answer)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			f.passwords = append(f.passwords, string(password))
		}
		_ = json.NewEncoder(w).Encode(daemonruntime.AnswerElevationResponse{Accepted: true})
	default:
		http.NotFound(w, r)
	}
}

// remoteElevationModel follows task t of topic a on runtime, with known_runtimes in a temp dir.
func remoteElevationModel(t *testing.T, runtime http.Handler) *chatModel {
	m := remoteTestModel(t, runtime.ServeHTTP)
	m.id, m.hasChat = "a", true
	m.width, m.height = 100, 30
	m.knownRuntimesPath = filepath.Join(t.TempDir(), "state", knownRuntimesFile)
	m.tasks["t"] = taskdomain.TaskInfo{ID: "t", TopicID: "a", Status: taskdomain.TaskRunning}
	// No countdown ticks: runCmd would wait for each.
	m.promptTicking = true
	t.Cleanup(m.closeStreams)
	return m
}

// runCmd runs cmd and its batches, feeding stream events and answer results back into m, until
// nothing is left. Commands that wait (cursor blinks, ticks) are skipped.
func runCmd(m *chatModel, cmd tea.Cmd) {
	queue := []tea.Cmd{cmd}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		if next == nil {
			continue
		}
		result := make(chan tea.Msg, 1)
		go func() { result <- next() }()
		var got tea.Msg
		select {
		case got = <-result:
		case <-time.After(300 * time.Millisecond):
			continue
		}
		switch msg := got.(type) {
		case tea.BatchMsg:
			queue = append(queue, msg...)
		case remoteStreamEvent, remotePromptResult:
			_, follow := m.Update(msg)
			if _, isStream := msg.(remoteStreamEvent); !isStream {
				queue = append(queue, follow)
			}
		}
	}
}

func TestRemoteElevationOverTheStreamSealsThePassword(t *testing.T) {
	const secret = "s3cret pass"
	runtime := newFakeElevationRuntime(t, testIdentity(t, 7))
	m := remoteElevationModel(t, runtime)
	runCmd(m, m.syncStreams())
	view := viewText(m)
	for _, want := range []string{"Administrator rights needed", "on build-box", "systemctl restart nginx", "/etc/nginx", "Password", "left"} {
		if !strings.Contains(view, want) {
			t.Fatalf("modal missing %q:\n%s", want, view)
		}
	}
	for _, key := range promptKeys(secret) {
		m.Update(key)
	}
	_, cmd := m.Update(promptKey(tea.KeyEnter))
	runCmd(m, cmd)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.passwords) != 1 || runtime.passwords[0] != secret {
		t.Fatalf("runtime got %q", runtime.passwords)
	}
	if strings.Contains(strings.Join(runtime.bodies, ""), secret) {
		t.Fatal("the password crossed the wire in the clear")
	}
	if m.activePrompt() != nil {
		t.Fatal("modal still open")
	}
	assertSecretNowhere(t, m, secret)
	if !strings.Contains(ansi.Strip(strings.Join(m.transcriptQueue, "\n")), "password sent") {
		t.Fatalf("transcript = %q", m.transcriptQueue)
	}
	// A loopback runtime is pinned without asking.
	known, err := loadKnownRuntimes(m.knownRuntimesPath)
	if err != nil || known[m.runtimeKey] != runtime.offer.Identity {
		t.Fatalf("known_runtimes = %v, %v", known, err)
	}
	if info, err := os.Stat(m.knownRuntimesPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("known_runtimes mode = %v, %v", info, err)
	}
	// The card is not opened again by a later snapshot of the same approval.
	m.syncRemotePrompts("t", runtime.frame())
	if m.activePrompt() != nil {
		t.Fatal("answered approval opened again")
	}
	// The runtime closing it prints nothing more.
	m.Update(remoteStreamEvent{gen: m.gen, id: "t", sub: m.streams["t"], frame: remoteStreamFrame{TaskID: "t", Seq: 9, Elevations: []remoteElevation{{ID: "el_1", Status: "allowed"}}}})
}

func TestRemoteElevationTrust(t *testing.T) {
	identity := testIdentity(t, 7)
	other := testIdentity(t, 9)
	const remoteKey = "https://console.example:8443/runtime"
	tests := []struct {
		name       string
		runtimeKey string
		pinned     *seal.Identity
		keys       []tea.Msg
		wantView   []string
		wantSent   bool
		wantPinned bool
	}{
		{
			name:       "first time on a remote runtime: confirm the fingerprint, then send",
			runtimeKey: remoteKey,
			keys:       append(append(promptKeys("y"), promptKeys("pw")...), promptKey(tea.KeyEnter)),
			wantView:   []string{seal.Fingerprint(identity.PublicKey()), "mistermorph console fingerprint", "y trust"},
			wantSent:   true,
			wantPinned: true,
		},
		{
			name:       "first time on a remote runtime: typing does not skip the check",
			runtimeKey: remoteKey,
			keys:       append(promptKeys("pw"), promptKey(tea.KeyEnter)),
			wantView:   []string{seal.Fingerprint(identity.PublicKey())},
		},
		{
			name:       "first time on a remote runtime: n declines",
			runtimeKey: remoteKey,
			keys:       promptKeys("n"),
			wantView:   []string{seal.Fingerprint(identity.PublicKey())},
		},
		{
			name:       "pinned and unchanged",
			runtimeKey: remoteKey,
			pinned:     identity,
			keys:       append(promptKeys("pw"), promptKey(tea.KeyEnter)),
			wantView:   []string{"Password"},
			wantSent:   true,
			wantPinned: true,
		},
		{
			name:       "identity changed: refuse to send",
			runtimeKey: remoteKey,
			pinned:     other,
			keys:       append(promptKeys("pw"), promptKey(tea.KeyEnter)),
			wantView:   []string{"identity key changed", "mistermorph chat --forget-runtime " + remoteKey, "Not sending the password"},
		},
		{
			name:       "identity changed on loopback too",
			runtimeKey: "http://127.0.0.1:9/runtime",
			pinned:     other,
			keys:       append(promptKeys("pw"), promptKey(tea.KeyEnter)),
			wantView:   []string{"identity key changed"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			runtime := newFakeElevationRuntime(t, identity)
			m := remoteElevationModel(t, runtime)
			m.runtimeKey = tc.runtimeKey
			if tc.pinned != nil {
				if err := pinKnownRuntime(m.knownRuntimesPath, tc.runtimeKey, seal.EncodePublicKey(tc.pinned.PublicKey())); err != nil {
					t.Fatal(err)
				}
			}
			runCmd(m, m.syncRemotePrompts("t", runtime.frame()))
			view := viewText(m)
			for _, want := range tc.wantView {
				if !strings.Contains(strings.Join(strings.Fields(view), " "), want) {
					t.Fatalf("modal missing %q:\n%s", want, view)
				}
			}
			for _, key := range tc.keys {
				_, cmd := m.Update(key)
				runCmd(m, cmd)
			}
			runtime.mu.Lock()
			sent := len(runtime.passwords) == 1 && runtime.passwords[0] == "pw"
			runtime.mu.Unlock()
			if sent != tc.wantSent {
				t.Fatalf("sent = %v, want %v:\n%s", sent, tc.wantSent, viewText(m))
			}
			known, _ := loadKnownRuntimes(m.knownRuntimesPath)
			wantIdentity := ""
			if tc.wantPinned {
				wantIdentity = seal.EncodePublicKey(identity.PublicKey())
			} else if tc.pinned != nil {
				wantIdentity = seal.EncodePublicKey(tc.pinned.PublicKey())
			}
			if known[tc.runtimeKey] != wantIdentity {
				t.Fatalf("pinned %q, want %q", known[tc.runtimeKey], wantIdentity)
			}
			// Esc always declines, even when the password may not be sent.
			if m.activePrompt() != nil {
				_, cmd := m.Update(promptKey(tea.KeyEscape))
				runCmd(m, cmd)
				runtime.mu.Lock()
				declines := runtime.declines
				runtime.mu.Unlock()
				if declines != 1 || m.activePrompt() != nil {
					t.Fatalf("Esc: declines = %d, open = %v", declines, m.activePrompt() != nil)
				}
			}
		})
	}
}

func TestRemoteElevationShowsTheRuntimesRefusal(t *testing.T) {
	runtime := newFakeElevationRuntime(t, testIdentity(t, 7))
	runtime.refuse = "the approval request is closed"
	m := remoteElevationModel(t, runtime)
	runCmd(m, m.syncRemotePrompts("t", runtime.frame()))
	for _, key := range promptKeys("pw") {
		m.Update(key)
	}
	_, cmd := m.Update(promptKey(tea.KeyEnter))
	runCmd(m, cmd)
	if m.activePrompt() == nil || !strings.Contains(viewText(m), "The runtime refused the answer: the approval request is closed") {
		t.Fatalf("refusal not shown:\n%s", viewText(m))
	}
	if strings.Contains(viewText(m), "••") {
		t.Fatal("the sent password stayed in the field")
	}
	// The runtime then closes the card in the stream.
	runCmd(m, m.syncRemotePrompts("t", remoteStreamFrame{Elevations: []remoteElevation{{ID: "el_1", Status: "rejected"}}}))
	if m.activePrompt() != nil || !strings.Contains(ansi.Strip(strings.Join(m.transcriptQueue, "\n")), "rejected") {
		t.Fatalf("card = %v, transcript %q", m.activePrompt() != nil, m.transcriptQueue)
	}
}

func TestRemoteQuestionAnswer(t *testing.T) {
	tests := []struct {
		name       string
		keys       []tea.Msg
		wantBody   map[string]any
		wantClosed string
	}{
		{name: "choice", keys: promptKeys("2"), wantBody: map[string]any{"question_id": "q1", "option": float64(1)}, wantClosed: "Answer: production"},
		{name: "typed", keys: append(promptKeys("tomorrow"), promptKey(tea.KeyEnter)), wantBody: map[string]any{"question_id": "q1", "option": float64(-1), "text": "tomorrow"}, wantClosed: "Answer: tomorrow"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got map[string]any
			m := remoteElevationModel(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/runtime/tasks/t/answer" {
					http.NotFound(w, r)
					return
				}
				_ = json.NewDecoder(r.Body).Decode(&got)
				answer, _ := got["text"].(string)
				if answer == "" {
					answer = "production"
				}
				_ = json.NewEncoder(w).Encode(daemonruntime.AnswerQuestionResponse{Answered: true, Answer: answer})
			}))
			frame := remoteStreamFrame{Questions: []remoteQuestion{{ID: "q1", Text: "Where to deploy?", Status: "open", Options: []taskruntime.UserQuestionOption{{Label: "staging"}, {Label: "production"}}}}}
			runCmd(m, m.syncRemotePrompts("t", frame))
			if !strings.Contains(viewText(m), "Where to deploy?") || !strings.Contains(viewText(m), "2. production") {
				t.Fatalf("card:\n%s", viewText(m))
			}
			for _, key := range tc.keys {
				_, cmd := m.Update(key)
				runCmd(m, cmd)
			}
			for k, v := range tc.wantBody {
				if got[k] != v {
					t.Fatalf("body = %v, want %v", got, tc.wantBody)
				}
			}
			if m.activePrompt() != nil || !strings.Contains(ansi.Strip(strings.Join(m.transcriptQueue, "\n")), tc.wantClosed) {
				t.Fatalf("open = %v, transcript %q", m.activePrompt() != nil, m.transcriptQueue)
			}
		})
	}
}

func TestRemotePromptsFollowTheTask(t *testing.T) {
	m := remoteElevationModel(t, http.NotFoundHandler())
	frame := remoteStreamFrame{Questions: []remoteQuestion{{ID: "q1", Text: "Now?", Status: "open"}}}
	runCmd(m, m.syncRemotePrompts("t", frame))
	if m.activePrompt() == nil {
		t.Fatal("no card")
	}
	// Answered elsewhere (the web Console): the card closes with the answer.
	runCmd(m, m.syncRemotePrompts("t", remoteStreamFrame{Questions: []remoteQuestion{{ID: "q1", Text: "Now?", Status: "answered", Answer: "yes"}}}))
	if m.activePrompt() != nil || !strings.Contains(ansi.Strip(strings.Join(m.transcriptQueue, "\n")), "Answer: yes") {
		t.Fatalf("transcript %q", m.transcriptQueue)
	}
	// A finished task's open card goes away with its stream.
	runCmd(m, m.syncRemotePrompts("t", remoteStreamFrame{Questions: []remoteQuestion{{ID: "q2", Text: "Later?", Status: "open"}}}))
	m.tasks["t"] = taskdomain.TaskInfo{ID: "t", TopicID: "a", Status: taskdomain.TaskDone}
	m.syncStreams()
	if m.activePrompt() != nil {
		t.Fatal("card outlived its task")
	}
}

func TestKnownRuntimesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", knownRuntimesFile)
	if err := pinKnownRuntime(path, "https://a.example", "AAA"); err != nil {
		t.Fatal(err)
	}
	if err := pinKnownRuntime(path, "http://127.0.0.1:8787", "BBB"); err != nil {
		t.Fatal(err)
	}
	known, err := loadKnownRuntimes(path)
	if err != nil || known["https://a.example"] != "AAA" || known["http://127.0.0.1:8787"] != "BBB" {
		t.Fatalf("known = %v, %v", known, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, %v", info, err)
	}
	for _, tc := range []struct {
		raw, want string
		loopback  bool
	}{
		{"https://a.example/", "https://a.example", false},
		{" https://a.example/runtime/ ", "https://a.example/runtime", false},
		{"http://localhost:8787", "http://localhost:8787", true},
		{"http://[::1]:8787/", "http://[::1]:8787", true},
		{"http://127.0.0.2", "http://127.0.0.2", true},
	} {
		got, err := runtimeTrustKey(tc.raw)
		if err != nil || got != tc.want || runtimeIsLoopback(got) != tc.loopback {
			t.Errorf("runtimeTrustKey(%q) = %q, %v (loopback %v)", tc.raw, got, err, runtimeIsLoopback(got))
		}
	}
	if _, err := runtimeTrustKey("console.example"); err == nil {
		t.Error("accepted an address without a scheme")
	}
}

func TestForgetRuntimeFlag(t *testing.T) {
	state := t.TempDir()
	viper.Set("file_state_dir", state)
	t.Cleanup(func() { viper.Set("file_state_dir", nil) })
	path := filepath.Join(state, knownRuntimesFile)
	if err := pinKnownRuntime(path, "https://a.example", "AAA"); err != nil {
		t.Fatal(err)
	}
	if err := pinKnownRuntime(path, "https://b.example", "BBB"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ arg, want string }{
		{"https://a.example/", "Forgot the identity pinned for https://a.example"},
		{"https://a.example", "No identity is pinned for https://a.example"},
	} {
		cmd := New(Dependencies{})
		var out bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetArgs([]string{"--forget-runtime", tc.arg})
		if err := cmd.ExecuteContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), tc.want) {
			t.Fatalf("output = %q, want %q", out.String(), tc.want)
		}
	}
	known, err := loadKnownRuntimes(path)
	if err != nil || len(known) != 1 || known["https://b.example"] != "BBB" {
		t.Fatalf("known = %v, %v", known, err)
	}
}
