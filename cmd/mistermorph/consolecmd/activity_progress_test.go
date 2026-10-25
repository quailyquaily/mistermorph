package consolecmd

import (
	"reflect"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

func TestUpdateConsoleActivityProgressMergesToolLifecycle(t *testing.T) {
	var progress *consoleActivityProgress

	progress, changed := updateConsoleActivityProgress(progress, agent.Event{
		Kind:       agent.EventKindToolStart,
		ActivityID: "tool:1",
		ToolName:   "web_search",
		Status:     "running",
		Args: map[string]any{
			"q": "mistermorph",
		},
	})
	if !changed || progress == nil {
		t.Fatalf("first update changed=%v progress=%#v, want non-nil progress", changed, progress)
	}

	progress, changed = updateConsoleActivityProgress(progress, agent.Event{
		Kind:       agent.EventKindToolDone,
		ActivityID: "tool:1",
		ToolName:   "web_search",
		Status:     "done",
	})
	if !changed {
		t.Fatal("tool done should update activity progress")
	}
	if progress.Current == nil {
		t.Fatal("progress.Current = nil")
	}
	if progress.Current.Status != "done" {
		t.Fatalf("progress.Current.Status = %q, want done", progress.Current.Status)
	}
	if progress.Current.Args["q"] != "mistermorph" {
		t.Fatalf("progress.Current.Args[q] = %#v, want mistermorph", progress.Current.Args["q"])
	}
	if len(progress.History) != 1 {
		t.Fatalf("len(progress.History) = %d, want 1", len(progress.History))
	}
	if _, err := time.Parse(time.RFC3339Nano, progress.Current.At); err != nil {
		t.Fatalf("progress.Current.At = %q, want RFC3339Nano timestamp: %v", progress.Current.At, err)
	}
}

func TestUpdateConsoleActivityProgressTracksSubtaskHistory(t *testing.T) {
	var progress *consoleActivityProgress

	progress, _ = updateConsoleActivityProgress(progress, agent.Event{
		Kind:       agent.EventKindSubtaskStart,
		ActivityID: "sub_1",
		TaskID:     "sub_1",
		Mode:       "agent",
		Profile:    string(agent.ObserveProfileWebExtract),
		Status:     "running",
	})
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{
		Kind:       agent.EventKindSubtaskDone,
		ActivityID: "sub_1",
		TaskID:     "sub_1",
		Status:     agent.SubtaskStatusDone,
		Summary:    "collected results",
		OutputKind: agent.SubtaskOutputKindJSON,
	})
	if progress == nil || progress.Current == nil {
		t.Fatalf("progress = %#v, want current entry", progress)
	}
	if progress.Current.Kind != "subtask" {
		t.Fatalf("progress.Current.Kind = %q, want subtask", progress.Current.Kind)
	}
	if progress.Current.Name != "sub_1" {
		t.Fatalf("progress.Current.Name = %q, want sub_1", progress.Current.Name)
	}
	if progress.Current.Summary != "collected results" {
		t.Fatalf("progress.Current.Summary = %q, want collected results", progress.Current.Summary)
	}
	if progress.Current.OutputKind != agent.SubtaskOutputKindJSON {
		t.Fatalf("progress.Current.OutputKind = %q, want %q", progress.Current.OutputKind, agent.SubtaskOutputKindJSON)
	}
}

func TestUpdateConsoleActivityProgressAppendsCoderOutput(t *testing.T) {
	var progress *consoleActivityProgress

	progress, _ = updateConsoleActivityProgress(progress, agent.Event{
		Kind:       agent.EventKindToolStart,
		ActivityID: "tool:coder",
		ToolName:   "coder",
		Status:     "running",
	})
	progress, changed := updateConsoleActivityProgress(progress, agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "coder",
		Stream:   "codex",
		Text:     "alpha",
		Status:   "running",
	})
	if !changed {
		t.Fatal("coder output should update activity progress")
	}
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "coder",
		Stream:   "codex",
		Text:     "\nbeta",
		Status:   "running",
	})
	if progress == nil || progress.Current == nil {
		t.Fatalf("progress = %#v, want current entry", progress)
	}
	if progress.Current.ID != "tool:coder" {
		t.Fatalf("progress.Current.ID = %q, want tool:coder", progress.Current.ID)
	}
	if progress.Current.Stream != "codex" {
		t.Fatalf("progress.Current.Stream = %q, want codex", progress.Current.Stream)
	}
	if progress.Current.Output != "alpha\nbeta" {
		t.Fatalf("progress.Current.Output = %q, want alpha newline beta", progress.Current.Output)
	}
	if progress.Current.Status != "running" {
		t.Fatalf("progress.Current.Status = %q, want running", progress.Current.Status)
	}
}

func TestUpdateConsoleActivityProgressRecordsAgentLinkExchange(t *testing.T) {
	start := func(id, parent string) agent.Event {
		return agent.Event{Kind: agent.EventKindToolStart, ActivityID: id, ParentActivityID: parent, ToolName: "agent_send", Status: "running"}
	}
	done := func(id, parent string) agent.Event {
		return agent.Event{Kind: agent.EventKindToolDone, ActivityID: id, ParentActivityID: parent, ToolName: "agent_send", Status: "done"}
	}
	output := func(id, stream, peer, text string) agent.Event {
		return agent.Event{Kind: agent.EventKindToolOutput, ActivityID: id, ToolName: "agent_send", Stream: stream, Summary: peer, Text: text, Status: "running"}
	}
	codemode := agent.Event{Kind: agent.EventKindToolStart, ActivityID: "cm", ToolName: "codemode", Status: "running"}

	cases := []struct {
		name   string
		events []agent.Event
		// want lists, for each call ID, the messages it holds as direction:peer:text.
		want map[string][]string
	}{
		{
			name: "direct call, output without an activity ID",
			events: []agent.Event{
				start("call_1", ""),
				output("", builtin.AgentLinkStreamSent, "墨墨", "what is your name?"),
				output("", builtin.AgentLinkStreamReply, "墨墨", "I am 墨墨."),
				done("call_1", ""),
			},
			want: map[string][]string{"call_1": {"sent:墨墨:what is your name?", "reply:墨墨:I am 墨墨."}},
		},
		{
			name: "codemode script call, output with its activity ID",
			events: []agent.Event{
				codemode,
				start("send_1", "cm"),
				output("send_1", builtin.AgentLinkStreamSent, "墨墨", "hi"),
				output("send_1", builtin.AgentLinkStreamReply, "墨墨", "hello"),
				done("send_1", "cm"),
			},
			want: map[string][]string{"send_1": {"sent:墨墨:hi", "reply:墨墨:hello"}},
		},
		{
			name: "codemode script call, output without an activity ID",
			events: []agent.Event{
				codemode,
				start("send_1", "cm"),
				output("", builtin.AgentLinkStreamSent, "墨墨", "hi"),
				output("", builtin.AgentLinkStreamPending, "墨墨", ""),
				done("send_1", "cm"),
			},
			want: map[string][]string{"send_1": {"sent:墨墨:hi", "pending:墨墨:"}},
		},
		{
			name: "two sends from one script, each keeps its own exchange",
			events: []agent.Event{
				codemode,
				start("send_1", "cm"),
				start("send_2", "cm"),
				output("send_1", builtin.AgentLinkStreamSent, "墨墨", "hi 墨墨"),
				output("send_2", builtin.AgentLinkStreamSent, "Emma", "hi Emma"),
				output("send_2", builtin.AgentLinkStreamReply, "Emma", "hello from Emma"),
				output("send_1", builtin.AgentLinkStreamReply, "墨墨", "hello from 墨墨"),
				done("send_1", "cm"),
				done("send_2", "cm"),
			},
			want: map[string][]string{
				"send_1": {"sent:墨墨:hi 墨墨", "reply:墨墨:hello from 墨墨"},
				"send_2": {"sent:Emma:hi Emma", "reply:Emma:hello from Emma"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var progress *consoleActivityProgress
			for _, event := range tc.events {
				var changed bool
				if progress, changed = updateConsoleActivityProgress(progress, event); !changed {
					t.Fatalf("%s %s did not change the activity", event.Kind, event.Stream)
				}
			}
			got := map[string][]string{}
			var collect func(entries []consoleActivityEntry)
			collect = func(entries []consoleActivityEntry) {
				for _, entry := range entries {
					for _, m := range entry.Messages {
						got[entry.ID] = append(got[entry.ID], m.Direction+":"+m.Peer+":"+m.Text)
					}
					if entry.Name == "agent_send" && entry.Status != "done" {
						t.Errorf("%s status = %q, want done", entry.ID, entry.Status)
					}
					collect(entry.Children)
				}
			}
			collect(progress.History)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("messages = %v, want %v", got, tc.want)
			}
		})
	}
}
