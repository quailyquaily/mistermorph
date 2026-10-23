package telegram

import (
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

func TestTelegramQuestionCallbackData(t *testing.T) {
	data := telegramQuestionCallbackData("a1b2c3d4e5f6", 3)
	if len(data) > 64 {
		t.Fatalf("callback data %q is over Telegram's 64 bytes", data)
	}
	id, option, ok := parseTelegramQuestionCallbackData(data)
	if !ok || id != "a1b2c3d4e5f6" || option != 3 {
		t.Fatalf("parse(%q) = %q, %d, %v", data, id, option, ok)
	}
	for _, raw := range []string{"", "ap:a:x", "aq:", "aq:id", "aq::1", "aq:id:x", "aq:id:-1"} {
		if _, _, ok := parseTelegramQuestionCallbackData(raw); ok {
			t.Fatalf("parse(%q) ok = true", raw)
		}
	}
}

func TestTelegramAsksUser(t *testing.T) {
	tests := []struct {
		job  telegramJob
		want bool
	}{
		{telegramJob{ChatType: "private"}, true},
		{telegramJob{ChatType: "private", FromIsAgent: true}, false},
		{telegramJob{ChatType: "group"}, false},
		{telegramJob{ChatType: "supergroup"}, false},
		{telegramJob{ChatType: "channel"}, false},
	}
	for _, tt := range tests {
		if got := telegramAsksUser(tt.job); got != tt.want {
			t.Fatalf("telegramAsksUser(%#v) = %v, want %v", tt.job, got, tt.want)
		}
	}
}

func TestTelegramQuestionMessage(t *testing.T) {
	q := taskruntime.UserQuestion{ID: "q1", Text: "Which account?", Options: []taskruntime.UserQuestionOption{
		{Label: "Personal", Description: "lyric@example.com"},
		{Label: "Company"},
	}}
	text := telegramQuestionText(q)
	for _, want := range []string{"Which account?", "1. **Personal** - lyric@example.com", "2. **Company**", "Tap a choice"} {
		if !strings.Contains(text, want) {
			t.Fatalf("question text %q lacks %q", text, want)
		}
	}
	markup := telegramQuestionReplyMarkup(q)
	if markup == nil || len(markup.InlineKeyboard) != 2 || markup.InlineKeyboard[1][0].Text != "Company" || markup.InlineKeyboard[1][0].CallbackData != "aq:q1:1" {
		t.Fatalf("reply markup = %#v", markup)
	}
	if telegramQuestionReplyMarkup(taskruntime.UserQuestion{ID: "q2", Text: "Why?"}) != nil {
		t.Fatal("an open question has buttons")
	}
	if got := telegramSettledQuestionText(q, &runtimecontrol.Answer{Text: "Company", Option: 1}); got != "Which account?\n\nAnswer: Company" {
		t.Fatalf("settled text = %q", got)
	}
	if got := telegramSettledQuestionText(q, nil); got != "Which account?\n\nNo answer." {
		t.Fatalf("expired text = %q", got)
	}
}
