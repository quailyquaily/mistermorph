package chathistory

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// toolTrace is a task result as stored: the trace's events, then the final answer.
func toolTrace(output string, events ...map[string]any) map[string]any {
	entries := make([]any, 0, len(events))
	for _, event := range events {
		entries = append(entries, map[string]any{"event": event})
	}
	return map[string]any{"trace": map[string]any{"entries": entries}, "final": map[string]any{"output": output}}
}

func toolDone(name string, args map[string]any, text string) map[string]any {
	return map[string]any{"kind": "tool_done", "tool_name": name, "status": "done", "args": args, "text": text}
}

func finishedTask(id string, created time.Time, task string, result map[string]any) taskdomain.TaskInfo {
	finished := created.Add(time.Minute)
	return taskdomain.TaskInfo{ID: id, TopicID: "topic", Task: task, Status: taskdomain.TaskDone, CreatedAt: created, FinishedAt: &finished, Result: result}
}

func TestTaskToolRecordListsTheAgentsOwnCalls(t *testing.T) {
	created := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	task := finishedTask("t1", created, "ask the coder", toolTrace("started",
		map[string]any{"kind": "tool_start", "tool_name": "coder"},
		map[string]any{"kind": "tool_output", "tool_name": "coder", "text": "Codex is working\n"},
		toolDone("coder", map[string]any{"task": "spawn kiwi", "coder": "codex"}, "started\n\n[Sub-agent /root/kiwi finished after this reply]\nKIWI"),
		// A call a codemode script made belongs to that call.
		map[string]any{"kind": "tool_done", "tool_name": "read_file", "parent_activity_id": "call_1", "text": "inner"},
		map[string]any{"kind": "tool_done", "tool_name": "bash", "status": "failed", "args": map[string]any{"cmd": "sleep 150"}, "error": "bash timed out after 2m0s", "text": "exit_code: 124"},
	))
	record, ok := TaskToolRecord(task)
	if !ok {
		t.Fatal("no record")
	}
	want := toolRecordIntro + "\n\n" +
		"1. coder {\"coder\":\"codex\",\"task\":\"spawn kiwi\"}\nresult: started\n\n[Sub-agent /root/kiwi finished after this reply]\nKIWI\n\n" +
		"2. bash {\"cmd\":\"sleep 150\"}\nfailed: bash timed out after 2m0s\nresult: exit_code: 124"
	if record.Text != want {
		t.Fatalf("record =\n%s\nwant\n%s", record.Text, want)
	}
	if record.Kind != KindToolRecord || record.MessageID != "t1:tools" || !record.SentAt.Equal(*task.FinishedAt) {
		t.Fatalf("record item = %+v", record)
	}
	// It has a boundary of its own, apart from the turn's message and reply.
	reply, _ := TaskOutbound(task)
	if b := BoundaryForItem(record); b == "" || b == BoundaryForItem(TaskInbound(task)) || b == BoundaryForItem(reply) {
		t.Fatalf("record boundary %q is not its own", b)
	}
}

func TestTaskToolRecordOnlyForFinishedTurnsThatCalledTools(t *testing.T) {
	created := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	called := toolTrace("done", toolDone("bash", map[string]any{"cmd": "ls"}, "a\nb"))
	running := finishedTask("t1", created, "list", called)
	running.FinishedAt, running.Status = nil, taskdomain.TaskRunning
	for name, task := range map[string]taskdomain.TaskInfo{
		"still running":   running,
		"no tools":        finishedTask("t2", created, "hello", toolTrace("hi", map[string]any{"kind": "llm_done"})),
		"no trace":        finishedTask("t3", created, "hello", map[string]any{"final": map[string]any{"output": "hi"}}),
		"no result":       finishedTask("t4", created, "hello", nil),
		"only inner call": finishedTask("t5", created, "x", toolTrace("y", map[string]any{"kind": "tool_done", "tool_name": "bash", "parent_activity_id": "c"})),
	} {
		if record, ok := TaskToolRecord(task); ok {
			t.Fatalf("%s: record %q", name, record.Text)
		}
	}
}

func TestTaskToolRecordIsTrimmed(t *testing.T) {
	created := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	long := strings.Repeat("头", 2000) + "THE END"
	var events []map[string]any
	for i := 0; i < 5; i++ {
		events = append(events, toolDone("bash", map[string]any{"cmd": long}, long))
	}
	record, ok := TaskToolRecord(finishedTask("t1", created, "much", toolTrace("done", events...)))
	if !ok {
		t.Fatal("no record")
	}
	// Long calls: the last two fit, numbered as they were made, and each keeps the end of its result.
	if !strings.Contains(record.Text, "(3 earlier calls are not listed.)") || strings.Contains(record.Text, "\n\n3. bash") || !strings.Contains(record.Text, "\n\n4. bash") || !strings.Contains(record.Text, "\n\n5. bash") {
		t.Fatalf("calls kept: %.300s", record.Text)
	}
	if got := strings.Count(record.Text, "THE END"); got != 2 {
		t.Fatalf("%d results keep their end, want 2", got)
	}
	if most := len(toolRecordIntro) + 100 + toolRecordMaxBytes; len(record.Text) > most {
		t.Fatalf("record is %d bytes, want at most %d", len(record.Text), most)
	}
	if !strings.Contains(record.Text, "bytes left out") || strings.ContainsRune(record.Text, '�') {
		t.Fatal("cut text is unmarked or cut inside a character")
	}
	// Short calls: no more than the last toolRecordMaxCalls.
	events = nil
	for i := 0; i < toolRecordMaxCalls+3; i++ {
		events = append(events, toolDone("bash", map[string]any{"cmd": "ls"}, "ok"))
	}
	record, _ = TaskToolRecord(finishedTask("t2", created, "many", toolTrace("done", events...)))
	if !strings.Contains(record.Text, "(3 earlier calls are not listed.)") || strings.Count(record.Text, "result: ok") != toolRecordMaxCalls {
		t.Fatalf("short calls kept: %s", record.Text)
	}
	// One call longer than the room for a record is still listed.
	record, ok = TaskToolRecord(finishedTask("t3", created, "one", toolTrace("done", toolDone("bash", map[string]any{"cmd": long}, long))))
	if !ok || !strings.Contains(record.Text, "1. bash") || strings.Contains(record.Text, "not listed") {
		t.Fatalf("single long call: %.200s", record.Text)
	}
}

// What the provider caches is the request's start: a turn's history must be, message for message,
// the start of the next turn's, records included.
func TestToolRecordsKeepTheHistoryPrefixStable(t *testing.T) {
	created := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	var tasks []taskdomain.TaskInfo
	for i, id := range []string{"t1", "t2", "t3", "t4"} {
		result := toolTrace("reply "+id, toolDone("bash", map[string]any{"b": 2, "a": 1, "cmd": "echo " + id}, "out "+id))
		if id == "t2" {
			result = map[string]any{"final": map[string]any{"output": "no tools here"}}
		}
		tasks = append(tasks, finishedTask(id, created.Add(time.Duration(i)*time.Hour), "ask "+id, result))
	}
	// Stores list the newest first.
	newestFirst := func(n int) []taskdomain.TaskInfo {
		out := make([]taskdomain.TaskInfo, 0, n)
		for i := n - 1; i >= 0; i-- {
			out = append(out, tasks[i])
		}
		return out
	}
	var previous []ChatHistoryItem
	for n := 1; n <= len(tasks); n++ {
		next := taskdomain.TaskInfo{ID: "next", CreatedAt: created.Add(time.Duration(n) * time.Hour)}
		history := BuildTaskHistoryWithToolRecords(newestFirst(n), next, 10)
		again := BuildTaskHistoryWithToolRecords(newestFirst(n), next, 10)
		if !reflect.DeepEqual(RenderHistoryMessages(history), RenderHistoryMessages(again)) {
			t.Fatalf("after %d turns: the same history rendered twice differs", n)
		}
		rendered, before := RenderHistoryMessages(history), RenderHistoryMessages(previous)
		if len(rendered) <= len(before) || (len(before) > 0 && !reflect.DeepEqual(rendered[:len(before)], before)) {
			t.Fatalf("after %d turns: the earlier history is not the start of this one", n)
		}
		seen := map[string]bool{}
		for _, item := range history {
			boundary := BoundaryForItem(item)
			if boundary == "" || seen[boundary] {
				t.Fatalf("after %d turns: boundary of %s %q is empty or repeated", n, item.Kind, item.MessageID)
			}
			seen[boundary] = true
		}
		previous = history
	}
	var kinds []string
	for _, item := range previous {
		kinds = append(kinds, item.Kind)
	}
	// Each turn: the message, the record when it called tools, the reply.
	want := []string{
		KindInboundUser, KindToolRecord, KindOutboundAgent,
		KindInboundUser, KindOutboundAgent,
		KindInboundUser, KindToolRecord, KindOutboundAgent,
		KindInboundUser, KindToolRecord, KindOutboundAgent,
	}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
	// Without records the history is as before.
	for _, item := range BuildTaskHistory(newestFirst(len(tasks)), taskdomain.TaskInfo{ID: "next", CreatedAt: created.Add(9 * time.Hour)}, 10) {
		if item.Kind == KindToolRecord {
			t.Fatal("BuildTaskHistory added a record")
		}
	}
}
