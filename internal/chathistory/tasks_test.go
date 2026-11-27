package chathistory

import (
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestBuildTaskHistoryIncludesPlanStepMessagesBeforeTheReply(t *testing.T) {
	created := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	finished := created.Add(time.Minute)
	// A console task result as stored: the plan's steps with the agent's notes, then the final answer.
	task := taskdomain.TaskInfo{
		ID: "t1", TopicID: "topic", Task: "make the slides", Status: taskdomain.TaskDone,
		CreatedAt: created, FinishedAt: &finished,
		Result: map[string]any{
			"final": map[string]any{"output": "review_zh.html is ready."},
			"plan": map[string]any{"steps": []any{
				map[string]any{"step": "read", "status": "completed", "note": "6 sections, 2 tables."},
				map[string]any{"step": "write", "status": "completed", "note": "Wrote 7 slides."},
				map[string]any{"step": "check", "status": "completed"},
			}},
		},
	}
	next := taskdomain.TaskInfo{ID: "t2", CreatedAt: finished.Add(time.Minute)}
	history := BuildTaskHistory([]taskdomain.TaskInfo{task}, next, 10)
	var texts []string
	for _, item := range history {
		texts = append(texts, item.Kind+": "+item.Text)
	}
	want := []string{
		KindInboundUser + ": make the slides",
		KindOutboundAgent + ": 6 sections, 2 tables.",
		KindOutboundAgent + ": Wrote 7 slides.",
		KindOutboundAgent + ": review_zh.html is ready.",
	}
	if len(texts) != len(want) {
		t.Fatalf("history = %q, want %q", texts, want)
	}
	for i := range want {
		if texts[i] != want[i] {
			t.Fatalf("history = %q, want %q", texts, want)
		}
	}
}

func TestTaskStepMessagesPutInsightsBeforeStepNotes(t *testing.T) {
	task := taskdomain.TaskInfo{ID: "t", Result: map[string]any{
		"insights": []any{"The timeout is 0.", " "},
		"plan":     map[string]any{"steps": []any{map[string]any{"step": "read", "status": "completed", "note": "6 sections."}}},
		"final":    map[string]any{"output": "done"},
	}}
	var texts []string
	for _, item := range TaskStepMessages(task) {
		texts = append(texts, item.Text)
	}
	if strings.Join(texts, "|") != "The timeout is 0.|6 sections." {
		t.Fatalf("step messages = %q", texts)
	}
}

func TestTaskStepMessagesWithoutAPlan(t *testing.T) {
	if got := TaskStepMessages(taskdomain.TaskInfo{ID: "t", Result: map[string]any{"final": map[string]any{"output": "hi"}}}); len(got) != 0 {
		t.Fatalf("step messages = %+v", got)
	}
}

func TestTaskResultOutputKeepsRepliesThatAreNotText(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result any
		want   string
	}{
		{"text", map[string]any{"final": &agent.Final{Output: " done "}}, "done"},
		{"list", map[string]any{"final": &agent.Final{Output: []any{"a", "b"}}}, `["a","b"]`},
		{"object", map[string]any{"final": agent.Final{Output: map[string]any{"n": 1}}}, `{"n":1}`},
		{"stored as JSON", map[string]any{"final": map[string]any{"output": []any{"a"}}}, `["a"]`},
		{"no output", map[string]any{"final": &agent.Final{}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := TaskResultOutput(tc.result); got != tc.want {
				t.Fatalf("TaskResultOutput() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestChildMessageHistoryText(t *testing.T) {
	applied := ChildMessageHistoryText(TaskChildMessage{ChildID: "worker-2", ChildName: "Curie", Text: " use metric units ", Status: "applied", Step: 4})
	if applied != "[Sent directly to the subagent Curie (worker-2) while it ran; it took it in at its step 4]\nuse metric units" {
		t.Fatalf("applied = %q", applied)
	}
	dropped := ChildMessageHistoryText(TaskChildMessage{ChildTaskID: "sub_1", Text: "stop", Status: "dropped"})
	if dropped != "[Sent directly to the subagent sub_1 while it ran; it finished before taking it in, so it was not applied]\nstop" {
		t.Fatalf("dropped = %q", dropped)
	}
}

// A Console message is from the person as its task recorded them: the name saved when it was
// sent, and the old name for a task that recorded none.
func TestTaskInboundUsesTheRecordedConsoleUserName(t *testing.T) {
	conversation := func(participants ...taskdomain.TaskParticipant) *taskdomain.TaskConversation {
		return &taskdomain.TaskConversation{ConversationID: "console:topic", ConversationType: "private", Participants: participants}
	}
	cases := []struct {
		name         string
		conversation *taskdomain.TaskConversation
		want         string
	}{
		{name: "no conversation", want: "Console User"},
		{name: "no participants", conversation: conversation(), want: "Console User"},
		{name: "legacy name", conversation: conversation(taskdomain.TaskParticipant{ID: "console:user", Nickname: "Console User"}), want: "Console User"},
		{name: "no name recorded", conversation: conversation(taskdomain.TaskParticipant{ID: "console:user"}), want: "Console User"},
		{name: "saved name", conversation: conversation(taskdomain.TaskParticipant{ID: "console:user", Nickname: "小明 🙂"}), want: "小明 🙂"},
		{name: "markup stays text", conversation: conversation(taskdomain.TaskParticipant{ID: "console:user", Nickname: "<b>Bo</b>"}), want: "<b>Bo</b>"},
		{name: "another participant", conversation: conversation(taskdomain.TaskParticipant{ID: "tg:42", Nickname: "Somebody"}), want: "Console User"},
		{name: "mentions beside the user", conversation: conversation(taskdomain.TaskParticipant{ID: "tg:42", Nickname: "Somebody"}, taskdomain.TaskParticipant{ID: "console:user", Nickname: "Lyra"}), want: "Lyra"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			task := taskdomain.TaskInfo{ID: "task_1", TopicID: "topic", Task: "hello", Conversation: tc.conversation}
			sender := TaskInbound(task).Sender
			if sender.Nickname != tc.want {
				t.Fatalf("nickname = %q, want %q", sender.Nickname, tc.want)
			}
			if sender.UserID != "console:user" || sender.Username != "console" || sender.DisplayRef != "console:user" {
				t.Fatalf("sender = %+v, want the fixed identifiers", sender)
			}
			prompt := BuildPromptMessage(TaskInbound(task))
			if prompt.Sender.Nickname != tc.want || prompt.Sender.Username != "console" {
				t.Fatalf("prompt sender = %+v", prompt.Sender)
			}
		})
	}
}

// A topic's history shows each message under the name its own task recorded.
func TestBuildTaskHistoryKeepsEachTasksConsoleUserName(t *testing.T) {
	at := time.Date(2026, 11, 27, 9, 0, 0, 0, time.UTC)
	named := func(name string) *taskdomain.TaskConversation {
		return &taskdomain.TaskConversation{Participants: []taskdomain.TaskParticipant{{ID: "console:user", Nickname: name}}}
	}
	tasks := []taskdomain.TaskInfo{
		{ID: "t3", Task: "third", Status: taskdomain.TaskDone, CreatedAt: at.Add(2 * time.Minute), Conversation: named("Ming")},
		{ID: "t2", Task: "second", Status: taskdomain.TaskDone, CreatedAt: at.Add(time.Minute), Conversation: named("小明")},
		{ID: "t1", Task: "first", Status: taskdomain.TaskDone, CreatedAt: at},
	}
	history := BuildTaskHistory(tasks, taskdomain.TaskInfo{ID: "t4", CreatedAt: at.Add(3 * time.Minute)}, 10)
	var got []string
	for _, item := range history {
		if item.Kind == KindInboundUser {
			got = append(got, item.Text+"="+item.Sender.Nickname)
		}
	}
	if want := "first=Console User,second=小明,third=Ming"; strings.Join(got, ",") != want {
		t.Fatalf("history senders = %v, want %s", got, want)
	}
}
