package slack

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

func TestSlackQuestionButtonValue(t *testing.T) {
	id, option, ok := parseSlackQuestionButtonValue(slackQuestionButtonValue("q1", 2))
	if !ok || id != "q1" || option != 2 {
		t.Fatalf("round trip = %q, %d, %v", id, option, ok)
	}
	for _, raw := range []string{"", "ap:a:x", "aq:", "aq:q1", "aq::0", "aq:q1:x", "aq:q1:-2"} {
		if _, _, ok := parseSlackQuestionButtonValue(raw); ok {
			t.Fatalf("parse(%q) ok = true", raw)
		}
	}
}

func TestSlackAsksUser(t *testing.T) {
	tests := []struct {
		job  slackJob
		want bool
	}{
		{slackJob{ChatType: "im"}, true},
		{slackJob{ChatType: "im", FromIsAgent: true}, false},
		{slackJob{ChatType: "mpim"}, false},
		{slackJob{ChatType: "channel"}, false},
		{slackJob{ChatType: "private_channel"}, false},
	}
	for _, tt := range tests {
		if got := slackAsksUser(tt.job); got != tt.want {
			t.Fatalf("slackAsksUser(%#v) = %v, want %v", tt.job, got, tt.want)
		}
	}
}

func TestParseSlackQuestionAction(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{
		"type": "block_actions",
		"actions": []map[string]any{
			{"action_id": "other", "value": "aq:q9:0"},
			{"action_id": "morph_ask_1", "value": "aq:q1:1"},
		},
	})
	id, option, ok, err := parseSlackQuestionAction(slackSocketEnvelope{Type: "interactive", Payload: payload})
	if err != nil || !ok || id != "q1" || option != 1 {
		t.Fatalf("parseSlackQuestionAction() = %q, %d, %v, %v", id, option, ok, err)
	}
	approval, _ := json.Marshal(map[string]any{
		"type":    "block_actions",
		"actions": []map[string]any{{"action_id": slackApprovalActionApprove, "value": "ap:a:x"}},
	})
	if _, _, ok, _ := parseSlackQuestionAction(slackSocketEnvelope{Type: "interactive", Payload: approval}); ok {
		t.Fatal("an approval button parsed as a question")
	}
}

func TestBuildSlackQuestionBlocks(t *testing.T) {
	q := taskruntime.UserQuestion{ID: "q1", Text: "Which account?", Options: []taskruntime.UserQuestionOption{
		{Label: "Personal", Description: "a <b>"},
		{Label: "Company"},
	}}
	blocks := buildSlackQuestionBlocks(q)
	if len(blocks) != 3 || blocks[1]["type"] != "actions" {
		t.Fatalf("blocks = %#v", blocks)
	}
	text := blocks[0]["text"].(map[string]any)["text"].(string)
	if !strings.Contains(text, "1. *Personal* - a &lt;b&gt;") || !strings.Contains(text, "2. *Company*") {
		t.Fatalf("question text = %q", text)
	}
	elements := blocks[1]["elements"].([]map[string]any)
	if len(elements) != 2 || elements[1]["action_id"] != "morph_ask_1" || elements[1]["value"] != "aq:q1:1" {
		t.Fatalf("buttons = %#v", elements)
	}
	if open := buildSlackQuestionBlocks(taskruntime.UserQuestion{ID: "q2", Text: "Why?"}); len(open) != 2 || open[1]["type"] != "context" {
		t.Fatalf("open question blocks = %#v", open)
	}
	settled := buildSlackSettledQuestionBlocks(q, &runtimecontrol.Answer{Text: "Company", Option: 1})
	if len(settled) != 2 || !strings.Contains(settled[1]["elements"].([]map[string]any)[0]["text"].(string), "Answer: Company") {
		t.Fatalf("settled blocks = %#v", settled)
	}
}
