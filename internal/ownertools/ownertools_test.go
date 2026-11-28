package ownertools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

const runID = "console_task_1"

type fixture struct {
	t       *testing.T
	root    string
	state   string
	topics  *daemonruntime.ConsoleFileStore
	ws      *workspace.Store
	sw      *pathroots.WorkspaceSwitch
	deps    Deps
	tools   map[string]tools.Tool
	topicWS string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	mustMkdir(t, state)
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	topicWS := mustMkdir(t, filepath.Join(root, "topic-ws"))
	f := &fixture{
		t:       t,
		root:    root,
		state:   state,
		topics:  store,
		ws:      workspace.NewStore(filepath.Join(state, "workspace_attachments.json")),
		sw:      pathroots.NewWorkspaceSwitch(topicWS),
		topicWS: topicWS,
	}
	f.deps = Deps{
		RunID:      runID,
		Topics:     store,
		Workspaces: f.ws,
		TopicWorkspace: func(_ context.Context, topicID string) (string, string, error) {
			res, err := workspace.Resolve(f.ws, ConsoleScopePrefix+topicID, f.deps.DefaultWorkspaceDir)
			return res.WorkspaceDir, string(res.Source), err
		},
		Switch:   f.sw,
		StateDir: state,
		HomeDir:  root,
	}
	f.build()
	return f
}

func (f *fixture) build() {
	f.tools = map[string]tools.Tool{}
	for _, tool := range New(f.deps) {
		f.tools[tool.Name()] = tool
	}
}

func mustMkdir(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// ownerCtx is the context of the owner's chat run the tools were built for.
func ownerCtx() context.Context {
	ctx := audience.NewContext(context.Background(), audience.Owner())
	return llmstats.WithRunID(ctx, runID)
}

func (f *fixture) call(ctx context.Context, name string, params map[string]any) (map[string]any, error) {
	f.t.Helper()
	if params == nil {
		params = map[string]any{}
	}
	raw, err := f.tools[name].Execute(ctx, params)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		f.t.Fatalf("%s result %q: %v", name, raw, err)
	}
	return out, nil
}

func (f *fixture) mustCall(name string, params map[string]any) map[string]any {
	f.t.Helper()
	out, err := f.call(ownerCtx(), name, params)
	if err != nil {
		f.t.Fatalf("%s(%v) error = %v", name, params, err)
	}
	return out
}

func (f *fixture) topic(title string, tags ...string) string {
	f.t.Helper()
	topic, err := f.topics.CreateNamedTopic(title)
	if err != nil {
		f.t.Fatal(err)
	}
	if len(tags) > 0 {
		if _, err := f.topics.SetTopicTags(topic.ID, tags); err != nil {
			f.t.Fatal(err)
		}
	}
	return topic.ID
}

var taskSeq int

func (f *fixture) task(topicID, message, reply string, at time.Time, edit func(*daemonruntime.TaskInfo)) string {
	f.t.Helper()
	taskSeq++
	info := daemonruntime.TaskInfo{
		ID:        fmt.Sprintf("task_%03d", taskSeq),
		Status:    daemonruntime.TaskDone,
		Task:      message,
		CreatedAt: at,
		TopicID:   topicID,
		Result:    map[string]any{"output": reply},
	}
	if edit != nil {
		edit(&info)
	}
	if err := f.topics.UpsertWithTrigger(info, daemonruntime.TaskTrigger{Source: "ui"}, ""); err != nil {
		f.t.Fatal(err)
	}
	return info.ID
}

func (f *fixture) attach(topicID, dir string) {
	f.t.Helper()
	if _, _, err := f.ws.Set(ConsoleScopePrefix+topicID, workspace.Attachment{WorkspaceDir: dir}); err != nil {
		f.t.Fatal(err)
	}
}

func workspacesOf(t *testing.T, out map[string]any) []map[string]any {
	t.Helper()
	raw, _ := out["workspaces"].([]any)
	var list []map[string]any
	for _, item := range raw {
		list = append(list, item.(map[string]any))
	}
	return list
}

func TestWorkspaceListDedupsAttachedDefaultAndRecent(t *testing.T) {
	f := newFixture(t)
	api := mustMkdir(t, filepath.Join(f.root, "proj", "api"))
	web := mustMkdir(t, filepath.Join(f.root, "proj", "web"))
	gone := filepath.Join(f.root, "gone")
	def := mustMkdir(t, filepath.Join(f.root, "default"))
	f.deps.DefaultWorkspaceDir = def
	f.build()

	t1 := f.topic("API work")
	t2 := f.topic("API bugs")
	t3 := f.topic("Website")
	deleted := f.topic("Old")
	f.attach(t1, api)
	f.attach(t2, api+"/") // the same folder, written differently
	f.attach(t3, web)
	f.attach(deleted, gone)
	if _, err := f.topics.DeleteTopic(deleted); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := f.ws.RecordUse(web, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := f.ws.RecordUse(gone, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}

	list := workspacesOf(t, f.mustCall(WorkspaceListName, nil))
	byPath := map[string]map[string]any{}
	var order []string
	for _, w := range list {
		path := w["path"].(string)
		if _, dup := byPath[path]; dup {
			t.Fatalf("listed twice: %s", path)
		}
		byPath[path] = w
		order = append(order, path)
	}
	// Newest use first: the missing recent one, then the website, then the attachments.
	if len(order) < 4 || order[0] != gone || order[1] != web {
		t.Fatalf("order = %v", order)
	}
	if byPath[gone]["exists"] != false || byPath[web]["exists"] != true {
		t.Fatalf("exists: gone %v web %v", byPath[gone]["exists"], byPath[web]["exists"])
	}
	apiEntry := byPath[api]
	if apiEntry == nil || len(apiEntry["topics"].([]any)) != 2 || !strings.Contains(fmt.Sprint(apiEntry["kinds"]), "attached") {
		t.Fatalf("api entry = %v", apiEntry)
	}
	titles := fmt.Sprint(apiEntry["topics"])
	if !strings.Contains(titles, "API work") || !strings.Contains(titles, "API bugs") {
		t.Fatalf("api topics = %s", titles)
	}
	if apiEntry["display"] != "~/proj/api" {
		t.Fatalf("display = %v", apiEntry["display"])
	}
	if !strings.Contains(fmt.Sprint(byPath[def]["kinds"]), "default") {
		t.Fatalf("default entry = %v", byPath[def])
	}
	if byPath[f.topicWS]["current"] != true || byPath[f.topicWS]["topic_workspace"] != true {
		t.Fatalf("topic workspace entry = %v", byPath[f.topicWS])
	}
	// The deleted topic's attachment brings no topic: the folder is there only as a recent use.
	if fmt.Sprint(byPath[gone]["topics"]) != "<nil>" {
		t.Fatalf("deleted topic listed: %v", byPath[gone])
	}

	// Bounded.
	out := f.mustCall(WorkspaceListName, map[string]any{"limit": 2.0})
	if len(workspacesOf(t, out)) != 2 || out["has_more"] != true {
		t.Fatalf("limited = %v", out)
	}
}

func TestWorkspaceListWithEmptyStores(t *testing.T) {
	f := newFixture(t)
	f.deps = Deps{RunID: runID}
	f.build()
	out := f.mustCall(WorkspaceListName, nil)
	if len(workspacesOf(t, out)) != 0 || out["has_more"] != false {
		t.Fatalf("empty = %v", out)
	}
}

func TestWorkspaceUseMovesFileToolsAndShellButNotTheAttachment(t *testing.T) {
	f := newFixture(t)
	other := mustMkdir(t, filepath.Join(f.root, "other"))
	topicID := f.topic("Mine")
	f.attach(topicID, f.topicWS)
	f.attach(f.topic("Other"), other)
	if err := os.WriteFile(filepath.Join(other, "notes.txt"), []byte("other notes"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx := pathroots.WithWorkspaceSwitch(ownerCtx(), f.sw)
	out, err := f.call(ctx, WorkspaceUseName, map[string]any{"path": other})
	if err != nil {
		t.Fatalf("workspace_use: %v", err)
	}
	if out["activity"] != "Using ~/other" || out["is_topic_own"] != false {
		t.Fatalf("result = %v", out)
	}
	if dir, _ := pathroots.WorkspaceDirFromContext(ctx); dir != other {
		t.Fatalf("workspace = %q", dir)
	}
	// The result says the file and shell tools work there now, and asks for no approval.
	if note, _ := out["note"].(string); strings.Contains(strings.ToLower(note), "approv") || !strings.Contains(note, "work here now") {
		t.Fatalf("note = %q", note)
	}
	// The topic keeps its attachment.
	if dir, err := workspace.LookupWorkspaceDir(f.ws, ConsoleScopePrefix+topicID); err != nil || dir != f.topicWS {
		t.Fatalf("attachment = %q, %v", dir, err)
	}
	// The real file tools and the shell follow the switch.
	roots := pathroots.New(f.topicWS, filepath.Join(f.root, "cache"), f.state)
	read, err := builtin.NewReadFileTool(0).Execute(ctx, map[string]any{"path": "notes.txt"})
	if err != nil || !strings.Contains(read, "other notes") {
		t.Fatalf("read_file = %q, %v", read, err)
	}
	if _, err := builtin.NewWriteFileTool(true, 0, roots).Execute(ctx, map[string]any{"path": "out.txt", "content": "x"}); err != nil {
		t.Fatalf("write_file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(other, "out.txt")); err != nil {
		t.Fatalf("write_file wrote elsewhere: %v", err)
	}
	if runtime.GOOS != "windows" {
		shell, err := builtin.NewBashTool(true, 10*time.Second, 4096, roots).Execute(ctx, map[string]any{"cmd": "pwd -P"})
		real, _ := filepath.EvalSymlinks(other)
		if err != nil || !strings.Contains(shell, real) {
			t.Fatalf("bash = %q, %v", shell, err)
		}
	}
	// The switch is remembered as a recent use.
	uses, _ := f.ws.RecentUses(5)
	if len(uses) == 0 || uses[0].WorkspaceDir != other {
		t.Fatalf("uses = %+v", uses)
	}
	// Back to the topic's own workspace.
	out = f.mustCall(WorkspaceUseName, map[string]any{"path": f.topicWS})
	if out["is_topic_own"] != true || f.sw.Switched() {
		t.Fatalf("back = %v", out)
	}
}

func TestWorkspaceUseRefusesUnknownMissingAndDeniedPaths(t *testing.T) {
	f := newFixture(t)
	stranger := mustMkdir(t, filepath.Join(f.root, "stranger"))
	secret := mustMkdir(t, filepath.Join(f.root, "secrets"))
	f.attach(f.topic("Secrets"), secret)
	f.deps.DenyPaths = []string{"secrets"}
	link := filepath.Join(f.root, "innocent")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	f.deps.UserText = "please look at " + link + " too"
	f.build()

	for name, path := range map[string]string{
		"unknown":       stranger,
		"missing":       filepath.Join(f.root, "nope"),
		"denied":        secret,
		"denied alias":  link,
		"state":         f.state,
		"inside state":  mustMkdir(t, filepath.Join(f.state, "skills")),
		"empty":         "",
		"longer prefix": stranger + "-x",
	} {
		if _, err := f.call(ownerCtx(), WorkspaceUseName, map[string]any{"path": path}); err == nil {
			t.Fatalf("%s: switch to %q accepted", name, path)
		}
		if f.sw.Current() != f.topicWS {
			t.Fatalf("%s: a refused switch moved the workspace to %q", name, f.sw.Current())
		}
	}
	if _, err := f.call(ownerCtx(), WorkspaceUseName, map[string]any{"path": stranger, "extra": 1.0}); err == nil {
		t.Fatal("unknown parameter accepted")
	}
}

func TestWorkspaceUseTakesAPathTheUserNamed(t *testing.T) {
	f := newFixture(t)
	named := mustMkdir(t, filepath.Join(f.root, "proj", "api"))
	mustMkdir(t, filepath.Join(f.root, "proj", "ap"))
	f.deps.UserText = "Fix the tests in ~/proj/api."
	f.build()
	if _, err := f.call(ownerCtx(), WorkspaceUseName, map[string]any{"path": filepath.Join(f.root, "proj", "ap")}); err == nil {
		t.Fatal("a prefix of the named path was accepted")
	}
	out := f.mustCall(WorkspaceUseName, map[string]any{"path": named})
	if out["workspace_dir"] != named {
		t.Fatalf("result = %v", out)
	}
	// A folder inside a known workspace is known too; a relative path starts from the current one.
	sub := mustMkdir(t, filepath.Join(named, "cmd"))
	f.deps.UserText = ""
	f.build()
	if out := f.mustCall(WorkspaceUseName, map[string]any{"path": "cmd"}); out["workspace_dir"] != sub {
		t.Fatalf("relative = %v", out)
	}
}

func TestMentionsPath(t *testing.T) {
	cases := []struct {
		text, path string
		want       bool
	}{
		{"use /a/b please", "/a/b", true},
		{"use /a/b.", "/a/b", true},
		{"use (/a/b)", "/a/b", true},
		{"use /a/b/", "/a/b", true},
		{"use /a/bc", "/a/b", false},
		{"use /a/b.v2", "/a/b", false},
		{"use x/a/b", "/a/b", false},
		{"use ~/p", "~/p", true},
		{"", "/a", false},
	}
	for _, c := range cases {
		if got := mentionsPath(c.text, c.path); got != c.want {
			t.Errorf("mentionsPath(%q, %q) = %v", c.text, c.path, got)
		}
	}
}

func topicsOf(out map[string]any) []map[string]any {
	raw, _ := out["topics"].([]any)
	var list []map[string]any
	for _, item := range raw {
		list = append(list, item.(map[string]any))
	}
	return list
}

func TestTopicSearchFindsTitlesTagsAndText(t *testing.T) {
	f := newFixture(t)
	base := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	billing := f.topic("Billing service", "payments")
	f.attach(billing, f.topicWS)
	f.task(billing, "Why does the invoice job fail?", "The cron entry uses the wrong timezone.", base, nil)
	docs := f.topic("Docs rewrite")
	f.task(docs, "Rewrite the install guide", "Done: the guide now covers Homebrew.", base.Add(time.Hour), nil)
	other := f.topic("Groceries", "home")
	f.task(other, "milk and eggs", "Added.", base.Add(2*time.Hour), nil)

	// Title.
	hits := topicsOf(f.mustCall(TopicSearchName, map[string]any{"query": "billing"}))
	if len(hits) != 1 || hits[0]["id"] != billing || fmt.Sprint(hits[0]["matched_in"]) != "[title]" {
		t.Fatalf("title hits = %v", hits)
	}
	if hits[0]["workspace"] != "~/topic-ws" || hits[0]["workspace_source"] != "attachment" {
		t.Fatalf("workspace = %v", hits[0])
	}
	// Tag.
	if hits := topicsOf(f.mustCall(TopicSearchName, map[string]any{"query": "payments"})); len(hits) != 1 || hits[0]["id"] != billing {
		t.Fatalf("tag hits = %v", hits)
	}
	if hits := topicsOf(f.mustCall(TopicSearchName, map[string]any{"tag": "home"})); len(hits) != 1 || hits[0]["id"] != other {
		t.Fatalf("tag filter = %v", hits)
	}
	// The user's message and the reply, across title and text, case-insensitive.
	hits = topicsOf(f.mustCall(TopicSearchName, map[string]any{"query": "Billing TIMEZONE"}))
	if len(hits) != 1 || !strings.Contains(hits[0]["excerpt"].(string), "timezone") || hits[0]["excerpt_task_id"] == "" {
		t.Fatalf("text hits = %v", hits)
	}
	if hits := topicsOf(f.mustCall(TopicSearchName, map[string]any{"query": "homebrew"})); len(hits) != 1 || hits[0]["id"] != docs {
		t.Fatalf("reply hits = %v", hits)
	}
	// Every word must match.
	if hits := topicsOf(f.mustCall(TopicSearchName, map[string]any{"query": "homebrew timezone"})); len(hits) != 0 {
		t.Fatalf("partial match = %v", hits)
	}
	// Bounded, most recently active first.
	out := f.mustCall(TopicSearchName, map[string]any{"limit": 2.0})
	if hits := topicsOf(out); len(hits) != 2 || out["has_more"] != true {
		t.Fatalf("limited = %v", out)
	}
}

func TestTopicReadPagesNewestFirst(t *testing.T) {
	f := newFixture(t)
	topicID := f.topic("Long talk")
	base := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	var ids []string
	for i := 0; i < 7; i++ {
		ids = append(ids, f.task(topicID, fmt.Sprintf("message %d", i), fmt.Sprintf("reply %d", i), base.Add(time.Duration(i)*time.Minute), nil))
	}
	long := strings.Repeat("x", readReplyRunes+100)
	ids = append(ids, f.task(topicID, "attach this", long, base.Add(time.Hour), func(info *daemonruntime.TaskInfo) {
		info.Attachments = []taskdomain.FileAttachment{{ID: "a1", Name: "report.pdf"}}
		info.FileReferences = []taskdomain.FileReference{{DirName: "workspace_dir", Path: "docs/spec.md"}}
	}))

	var seen []string
	cursor := ""
	for page := 0; page < 5; page++ {
		params := map[string]any{"topic_id": topicID, "limit": 3.0}
		if cursor != "" {
			params["cursor"] = cursor
		}
		out := f.mustCall(TopicReadName, params)
		turns, _ := out["turns"].([]any)
		for _, raw := range turns {
			turn := raw.(map[string]any)
			seen = append(seen, turn["task_id"].(string))
			if turn["task_id"] == ids[len(ids)-1] {
				if turn["reply_truncated"] != true || len([]rune(turn["reply"].(string))) > readReplyRunes+1 {
					t.Fatalf("long reply not cut: %d runes", len([]rune(turn["reply"].(string))))
				}
				if fmt.Sprint(turn["files"]) != "[report.pdf]" || fmt.Sprint(turn["referenced_files"]) != "[spec.md]" {
					t.Fatalf("files = %v %v", turn["files"], turn["referenced_files"])
				}
			}
		}
		next, _ := out["next_cursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) != len(ids) {
		t.Fatalf("read %d turns, want %d: %v", len(seen), len(ids), seen)
	}
	for i := range seen {
		if seen[i] != ids[len(ids)-1-i] {
			t.Fatalf("order = %v, want newest first of %v", seen, ids)
		}
	}
	if _, err := f.call(ownerCtx(), TopicReadName, map[string]any{"topic_id": topicID, "cursor": "garbage"}); err == nil {
		t.Fatal("invalid cursor accepted")
	}
	if _, err := f.call(ownerCtx(), TopicReadName, map[string]any{"topic_id": "nope"}); err == nil {
		t.Fatal("unknown topic read")
	}
}

func TestTopicToolsSkipAnotherAudiencesTasks(t *testing.T) {
	f := newFixture(t)
	topicID := f.topic("Mixed")
	base := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	f.task(topicID, "owner says hello", "hi", base, nil)
	f.task(topicID, "contact secret plan", "ok", base.Add(time.Minute), func(info *daemonruntime.TaskInfo) {
		info.Conversation = &taskdomain.TaskConversation{Audience: audience.Contact("c1").String()}
	})
	out := f.mustCall(TopicReadName, map[string]any{"topic_id": topicID})
	if strings.Contains(fmt.Sprint(out["turns"]), "secret") {
		t.Fatalf("another audience's task was read: %v", out["turns"])
	}
	if hits := topicsOf(f.mustCall(TopicSearchName, map[string]any{"query": "secret"})); len(hits) != 0 {
		t.Fatalf("another audience's task was searched: %v", hits)
	}
}

func TestToolsRefuseOutsideTheOwnersRun(t *testing.T) {
	f := newFixture(t)
	f.topic("Anything")
	cases := map[string]context.Context{
		"no audience": llmstats.WithRunID(context.Background(), runID),
		"contact":     llmstats.WithRunID(audience.NewContext(context.Background(), audience.Contact("c1")), runID),
		"group":       llmstats.WithRunID(audience.NewContext(context.Background(), audience.Conversation("tg:1")), runID),
		"other run":   llmstats.WithRunID(audience.NewContext(context.Background(), audience.Owner()), "cron:1"),
		"subtask":     agent.WithSubtaskDepth(ownerCtx(), 1),
	}
	for name, ctx := range cases {
		for _, tool := range Names {
			params := map[string]any{"topic_id": "x", "path": f.topicWS}
			if tool == WorkspaceListName || tool == TopicSearchName {
				params = map[string]any{}
			}
			if _, err := f.call(ctx, tool, params); err == nil || !strings.Contains(err.Error(), "owner's own Console chat runs") {
				t.Fatalf("%s: %s error = %v", name, tool, err)
			}
		}
	}
	// Built without a run (the schema catalog), they never run.
	for _, tool := range Catalog() {
		if _, err := tool.Execute(ownerCtx(), map[string]any{}); err == nil {
			t.Fatalf("catalog %s ran", tool.Name())
		}
		// work_thread is how Solo hands off work: always listed in Solo's runs.
		if tool.Name() != WorkThreadName && !tools.IsDeferred(tool) || !tools.IsSubtaskExcluded(tool) {
			t.Fatalf("%s is not deferred and kept from subtasks", tool.Name())
		}
	}
	if !tools.IsCodeModeExcluded(f.tools[WorkspaceUseName]) {
		t.Fatal("workspace_use can be called from a script")
	}
}
