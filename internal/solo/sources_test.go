package solo

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

func toolDone(name string, args map[string]any, text string) agent.Event {
	return agent.Event{Kind: agent.EventKindToolDone, RunID: "run1", ToolName: name, Args: args, Text: text}
}

func uses(pairs ...any) []daemonruntime.SoloSourceUse {
	var out []daemonruntime.SoloSourceUse
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, daemonruntime.SoloSourceUse{Action: pairs[i].(string), Count: pairs[i+1].(int)})
	}
	return out
}

// Every successful call adds to its source's uses: the source stays one chip, where the run
// first used it, and its uses keep the order each action first happened.
func TestSourceCollectorAggregatesUses(t *testing.T) {
	ws := t.TempDir()
	ctx := pathroots.WithWorkspaceDir(context.Background(), ws)
	c := NewSourceCollector("run1")
	for _, event := range []agent.Event{
		toolDone("memory_search", nil, "[]"),
		toolDone("read_file", map[string]any{"path": "a.md"}, "x"),
		toolDone("bash", map[string]any{"cmd": "ls"}, "a.md"),
		toolDone("read_file", map[string]any{"path": "b.md"}, "y"),
		toolDone("write_file", map[string]any{"path": "c.md", "content": "z"}, "ok"),
		toolDone("powershell", map[string]any{"cmd": "dir"}, "a.md"),
		toolDone("coder", nil, "done"),
		toolDone("read_file", map[string]any{"path": "a.md"}, "x"),
		toolDone("memory_save", nil, "ok"),
		toolDone("memory_search", nil, "[]"),
		toolDone("memory_forget", nil, "ok"),
		toolDone("journal_search", nil, "x"),
		toolDone("journal_read", nil, "x"),
		toolDone("journal_read", nil, "x"),
		toolDone("topic_read", nil, `{"topic":{"id":"t1","title":"Pricing"}}`),
		toolDone("topic_read", nil, `{"topic":{"id":"t1","title":"Pricing"}}`),
		toolDone("work_thread", nil, `{"topic_id":"t2","title":"Build"}`),
		toolDone("work_thread", nil, `{"topic_id":"t2","title":"Build"}`),
	} {
		c.HandleEvent(ctx, event)
	}
	got := c.Sources()
	if len(got) != 5 {
		t.Fatalf("sources = %+v", got)
	}
	want := map[string][]daemonruntime.SoloSourceUse{
		"memory":    uses("search", 2, "save", 1, "forget", 1),
		"workspace": uses("read_file", 3, "shell", 2, "write_file", 1, "coder", 1),
		"journal":   uses("search", 1, "read", 2),
		"topic":     uses("read", 2),
		"thread":    uses("start", 2),
	}
	order := []string{"memory", "workspace", "journal", "topic", "thread"}
	for i, source := range got {
		if source.Kind != order[i] {
			t.Fatalf("source %d = %s, want %s", i, source.Kind, order[i])
		}
		if !reflect.DeepEqual(source.Uses, want[source.Kind]) {
			t.Fatalf("%s uses = %+v, want %+v", source.Kind, source.Uses, want[source.Kind])
		}
	}
}

// A topic the reply reads that Solo started as a thread, in an earlier reply, shows as a thread;
// what says so is the topic's stored record, not the call's output. Ordinary topics stay topics.
func TestSourceCollectorReadsSoloThreadAsThread(t *testing.T) {
	asked := []string{}
	c := NewSourceCollector("run1").WithSoloThreads(func(topicID string) bool {
		asked = append(asked, topicID)
		return topicID == "thread1"
	})
	ctx := context.Background()
	// The output's own started_from is not what decides.
	c.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":"plain","title":"Pricing","started_from":"_solo"}}`))
	c.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":" thread1 ","title":"Build"}}`))
	c.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":"thread1","title":"Build"}}`))
	want := []daemonruntime.SoloSource{
		{Kind: "topic", ID: "plain", Label: "Pricing", Uses: uses("read", 1)},
		{Kind: "thread", ID: "thread1", Label: "Build", Uses: uses("read", 2)},
	}
	if got := c.Sources(); !reflect.DeepEqual(got, want) {
		t.Fatalf("sources = %+v, want %+v", got, want)
	}
	if !reflect.DeepEqual(asked, []string{"plain", "thread1", "thread1"}) {
		t.Fatalf("asked about %q", asked)
	}
	// Without the lookup, and for a nil collector, a topic read is a topic.
	bare := NewSourceCollector("run1").WithSoloThreads(nil)
	bare.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":"thread1","title":"Build"}}`))
	if got := bare.Sources(); len(got) != 1 || got[0].Kind != "topic" {
		t.Fatalf("sources without a lookup = %+v", got)
	}
	var none *SourceCollector
	if none.WithSoloThreads(func(string) bool { return true }) != nil {
		t.Fatal("nil collector became one")
	}
}

// A thread the reply both starts (or gives more work) and reads is one thread chip, whichever
// came first and whether or not the stored record already said it was a thread at the read.
func TestSourceCollectorFoldsReadsIntoTheThread(t *testing.T) {
	ctx := context.Background()
	read := toolDone("topic_read", nil, `{"topic":{"id":"t2","title":"Build"}}`)
	start := toolDone("work_thread", nil, `{"topic_id":"t2","title":"Build"}`)
	cases := []struct {
		name   string
		known  bool
		events []agent.Event
		want   []daemonruntime.SoloSourceUse
	}{
		{"started then read, known", true, []agent.Event{start, read, read}, uses("start", 1, "read", 2)},
		{"read then given more work, known", true, []agent.Event{read, start}, uses("read", 1, "start", 1)},
		{"started then read, unknown", false, []agent.Event{start, read}, uses("start", 1, "read", 1)},
		{"read then started, unknown", false, []agent.Event{read, start, read}, uses("start", 1, "read", 2)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := NewSourceCollector("run1").WithSoloThreads(func(string) bool { return tc.known })
			c.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":"t1","title":"Pricing"}}`))
			for _, event := range tc.events {
				c.HandleEvent(ctx, event)
			}
			got := c.Sources()
			if tc.known {
				// The lookup calls every topic a thread here, the first one too.
				if len(got) != 2 || got[0].Kind != "thread" || got[0].ID != "t1" {
					t.Fatalf("sources = %+v", got)
				}
			} else if len(got) != 2 || got[0].Kind != "topic" || got[0].ID != "t1" {
				t.Fatalf("sources = %+v", got)
			}
			if got[1].Kind != "thread" || got[1].ID != "t2" || !reflect.DeepEqual(got[1].Uses, tc.want) {
				t.Fatalf("thread = %+v, want uses %+v", got[1], tc.want)
			}
			// Folding again gives the same: the collector's own counts did not move.
			if again := c.Sources(); !reflect.DeepEqual(again, got) {
				t.Fatalf("second Sources() = %+v, first %+v", again, got)
			}
		})
	}
}

// Only successful calls of the run itself count as uses.
func TestSourceCollectorUsesSuccessfulCallsOnly(t *testing.T) {
	ws := t.TempDir()
	ctx := pathroots.WithWorkspaceDir(context.Background(), ws)
	c := NewSourceCollector("run1")
	c.HandleEvent(ctx, toolDone("bash", nil, "ok"))
	failed := toolDone("bash", nil, "boom")
	failed.Error = "exit 1"
	c.HandleEvent(ctx, failed)
	other := toolDone("bash", nil, "ok")
	other.RunID = "other"
	c.HandleEvent(ctx, other)
	worker := toolDone("bash", nil, "ok")
	worker.Worker = &agent.WorkerMetadata{ID: "w"}
	c.HandleEvent(ctx, worker)
	c.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolStart, RunID: "run1", ToolName: "bash"})
	// A file outside the workspace is no use of it.
	c.HandleEvent(ctx, toolDone("read_file", map[string]any{"path": "/etc/hosts"}, "x"))
	failedMemory := toolDone("memory_save", nil, "")
	failedMemory.Error = "refused"
	c.HandleEvent(ctx, failedMemory)
	got := c.Sources()
	want := []daemonruntime.SoloSource{{Kind: "workspace", ID: ws, Label: got[0].Label, Uses: uses("shell", 1)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sources = %+v, want %+v", got, want)
	}
}

// What is kept says what was done, never with what: no argument, output, command, path below
// the workspace, file content or search text reaches the record.
func TestSourceCollectorKeepsNoPayload(t *testing.T) {
	ws := t.TempDir()
	ctx := pathroots.WithWorkspaceDir(context.Background(), ws)
	c := NewSourceCollector("run1")
	c.HandleEvent(ctx, toolDone("bash", map[string]any{"cmd": "cat SECRET-CMD"}, "SECRET-OUT"))
	c.HandleEvent(ctx, toolDone("read_file", map[string]any{"path": "SECRET-PATH.md"}, "SECRET-CONTENT"))
	c.HandleEvent(ctx, toolDone("write_file", map[string]any{"path": "out.md", "content": "SECRET-WRITTEN"}, "ok"))
	c.HandleEvent(ctx, toolDone("memory_search", map[string]any{"query": "SECRET-QUERY"}, "SECRET-HIT"))
	c.HandleEvent(ctx, toolDone("journal_search", map[string]any{"query": "SECRET-QUERY"}, "SECRET-HIT"))
	raw, err := json.Marshal(c.Sources())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "SECRET") {
		t.Fatalf("payload in the record: %s", raw)
	}
}

// A use's count stops at its bound.
func TestSourceCollectorBoundsCounts(t *testing.T) {
	c := NewSourceCollector("run1")
	for i := 0; i < daemonruntime.SoloSourceUseMaxCount+5; i++ {
		c.HandleEvent(context.Background(), toolDone("memory_search", nil, ""))
	}
	got := c.Sources()
	if len(got) != 1 || !reflect.DeepEqual(got[0].Uses, uses("search", daemonruntime.SoloSourceUseMaxCount)) {
		t.Fatalf("sources = %+v", got)
	}
}

// Sources hands out a snapshot: later calls change neither it nor, through it, the collector.
func TestSourceCollectorSourcesIsDetached(t *testing.T) {
	c := NewSourceCollector("run1")
	c.HandleEvent(context.Background(), toolDone("memory_search", nil, ""))
	first := c.Sources()
	c.HandleEvent(context.Background(), toolDone("memory_search", nil, ""))
	c.HandleEvent(context.Background(), toolDone("memory_save", nil, ""))
	if !reflect.DeepEqual(first[0].Uses, uses("search", 1)) {
		t.Fatalf("snapshot changed: %+v", first[0].Uses)
	}
	first[0].Uses[0].Count = 99
	first[0].Uses = append(first[0].Uses, daemonruntime.SoloSourceUse{Action: "x", Count: 1})
	if got := c.Sources(); !reflect.DeepEqual(got[0].Uses, uses("search", 2, "save", 1)) {
		t.Fatalf("collector changed through its snapshot: %+v", got[0].Uses)
	}
}

// A record from before uses were kept reads as it was, and is written back unchanged.
func TestSoloSourceOldJSON(t *testing.T) {
	old := `[{"kind":"workspace","id":"/home/u/proj","label":"~/proj"},{"kind":"memory"}]`
	var sources []daemonruntime.SoloSource
	if err := json.Unmarshal([]byte(old), &sources); err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 || sources[0].ID != "/home/u/proj" || sources[0].Label != "~/proj" || sources[0].Uses != nil || sources[1].Uses != nil {
		t.Fatalf("sources = %+v", sources)
	}
	again, err := json.Marshal(sources)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != old {
		t.Fatalf("written back as %s", again)
	}
	withUses := `[{"kind":"journal","uses":[{"action":"read","count":2}]}]`
	var kept []daemonruntime.SoloSource
	if err := json.Unmarshal([]byte(withUses), &kept); err != nil {
		t.Fatal(err)
	}
	if again, _ := json.Marshal(kept); string(again) != withUses {
		t.Fatalf("written back as %s", again)
	}
}

// The chip of a thread the reply started names that start's task, so the Console can show who
// worked on exactly that task; a thread the reply only read names none.
func TestSourceCollectorKeepsTheStartedTask(t *testing.T) {
	ctx := context.Background()
	c := NewSourceCollector("run1").WithSoloThreads(func(string) bool { return true })
	c.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":"t0","title":"Earlier"}}`))
	c.HandleEvent(ctx, toolDone("work_thread", nil, `{"topic_id":"t1","task_id":" task-a ","title":"Build","workspace":"~/p"}`))
	c.HandleEvent(ctx, toolDone("topic_read", nil, `{"topic":{"id":"t1","title":"Build"}}`))
	c.HandleEvent(ctx, toolDone("work_thread", nil, `{"topic_id":"t2","task_id":"task-b","title":"Docs"}`))
	want := []daemonruntime.SoloSource{
		{Kind: "thread", ID: "t0", Label: "Earlier", Uses: uses("read", 1)},
		{Kind: "thread", ID: "t1", Label: "Build", TaskID: "task-a", Uses: uses("start", 1, "read", 1)},
		{Kind: "thread", ID: "t2", Label: "Docs", TaskID: "task-b", Uses: uses("start", 1)},
	}
	if got := c.Sources(); !reflect.DeepEqual(got, want) {
		t.Fatalf("sources = %+v, want %+v", got, want)
	}
	raw, _ := json.Marshal(c.Sources()[:2])
	if string(raw) != `[{"kind":"thread","id":"t0","label":"Earlier","uses":[{"action":"read","count":1}]},{"kind":"thread","id":"t1","label":"Build","task_id":"task-a","uses":[{"action":"start","count":1},{"action":"read","count":1}]}]` {
		t.Fatalf("sources JSON = %s", raw)
	}
}

// One reply can start a task in a thread and, once that ended, give the same thread more work:
// two tasks, one chip. The chip then names neither, rather than one of them, and keeps both uses.
func TestSourceCollectorNamesNoTaskForAThreadStartedTwice(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		starts []string
		task   string
		count  int
	}{
		{"two tasks", []string{`"task-a"`, `"task-b"`}, "", 2},
		{"three tasks", []string{`"task-a"`, `"task-b"`, `"task-c"`}, "", 3},
		{"the same task reported twice", []string{`"task-a"`, `"task-a"`}, "task-a", 2},
		{"a start that named no task, then one that did", []string{`""`, `"task-b"`}, "", 2},
		{"a start that named a task, then one that did not", []string{`"task-a"`, `""`}, "", 2},
		{"no task named", []string{`""`}, "", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := NewSourceCollector("run1")
			for _, task := range tc.starts {
				c.HandleEvent(ctx, toolDone("work_thread", nil, `{"topic_id":"t1","task_id":`+task+`,"title":"Build"}`))
			}
			// Another thread of the same reply keeps its own task.
			c.HandleEvent(ctx, toolDone("work_thread", nil, `{"topic_id":"t2","task_id":"task-z","title":"Docs"}`))
			got := c.Sources()
			if len(got) != 2 || got[0].ID != "t1" || got[0].TaskID != tc.task || !reflect.DeepEqual(got[0].Uses, uses("start", tc.count)) {
				t.Fatalf("thread = %+v, want task %q and %d starts", got, tc.task, tc.count)
			}
			if got[1].ID != "t2" || got[1].TaskID != "task-z" {
				t.Fatalf("other thread = %+v", got[1])
			}
		})
	}
}
