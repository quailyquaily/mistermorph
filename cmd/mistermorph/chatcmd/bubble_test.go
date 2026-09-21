package chatcmd

import (
	"context"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
)

func TestNewChatModel(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	if m.textarea.ShowLineNumbers {
		t.Error("ShowLineNumbers should be false")
	}
	if m.thinking {
		t.Error("thinking should be false initially")
	}
	if len(m.inputHistory) != 0 {
		t.Errorf("history should be empty, got %d", len(m.inputHistory))
	}
}

func TestChatModelWindowSize(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	// simulate a window resize
	m2, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	cm := m2.(*chatModel)

	if cm.width != 100 {
		t.Errorf("width = %d, want 100", cm.width)
	}

	expectedTW := 100 - 1 - inputMarkerWidth
	if cm.textarea.Width() != expectedTW {
		t.Errorf("textarea width = %d, want %d", cm.textarea.Width(), expectedTW)
	}
}

func TestWrapChatTranscriptAvoidsTerminalAutoWrap(t *testing.T) {
	t.Parallel()

	got := wrapChatTranscript("Linux "+strings.Repeat("x", 40), 20)
	lines := strings.Split(got, "\n")
	if len(lines) < 2 {
		t.Fatalf("wrapped transcript lines = %#v, want multiple lines", lines)
	}
	for _, line := range lines {
		if width := ansi.StringWidth(line); width > 19 {
			t.Fatalf("wrapped transcript line width = %d, want <= 19: %q", width, line)
		}
	}
}

func TestChatTranscriptQueuePrintsBlocksSequentially(t *testing.T) {
	t.Parallel()

	m := newChatModel(&chatSession{})
	_, firstCmd := m.Update(tuiOutputMsg{output: "first"})
	if firstCmd == nil {
		t.Fatal("first transcript block did not start printing")
	}

	_, secondCmd := m.Update(tuiOutputMsg{output: "second"})
	if secondCmd != nil {
		t.Fatal("second transcript block started before the first completed")
	}
	if got := m.transcriptQueue; len(got) != 2 || got[0] != "first" || got[1] != "second" {
		t.Fatalf("transcript queue = %#v, want [first second]", got)
	}

	_, nextCmd := m.Update(transcriptPrintedMsg{})
	if nextCmd == nil {
		t.Fatal("second transcript block did not start after acknowledgement")
	}
	if got := m.transcriptQueue; len(got) != 1 || got[0] != "second" {
		t.Fatalf("transcript queue after first acknowledgement = %#v, want [second]", got)
	}

	_, doneCmd := m.Update(transcriptPrintedMsg{})
	if doneCmd != nil || len(m.transcriptQueue) != 0 {
		t.Fatalf("transcript queue did not become idle: queue=%#v cmd=%v", m.transcriptQueue, doneCmd)
	}
}

func TestChatModelSubmit(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	// type something and press enter
	m.textarea.SetValue("hello world")
	m2, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))
	cm := m2.(*chatModel)

	// should produce a tea.Println command
	if cmd == nil {
		t.Fatal("expected a command after Enter, got nil")
	}

	// textarea should be reset
	if cm.textarea.Value() != "" {
		t.Errorf("textarea value = %q, want empty after submit", cm.textarea.Value())
	}

	// input should be in history
	if len(cm.inputHistory) != 1 || cm.inputHistory[0] != "hello world" {
		t.Errorf("history = %v, want [hello world]", cm.inputHistory)
	}
}

func TestChatModelHistoryNavigation(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.inputHistory = []string{"first", "second", "third"}
	m.historyIdx = 3

	// press up twice
	m2, _ := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyUp}))
	m = m2.(*chatModel)
	m3, _ := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyUp}))
	m = m3.(*chatModel)
	if m.textarea.Value() != "second" {
		t.Errorf("after 2x up, value = %q, want second", m.textarea.Value())
	}

	// press down once
	m4, _ := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyDown}))
	m = m4.(*chatModel)
	if m.textarea.Value() != "third" {
		t.Errorf("after down, value = %q, want third", m.textarea.Value())
	}

	// press down past the end
	m5, _ := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyDown}))
	m = m5.(*chatModel)
	if m.textarea.Value() != "" {
		t.Errorf("after down past end, value = %q, want empty", m.textarea.Value())
	}
}

func TestChatModelAutocomplete(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	reg := chatcommands.NewRegistry()
	reg.Register("/exit", "exit the chat session", nil)
	m.commandRegistry = reg
	m.textarea.SetValue("/ex")

	m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyTab}))
	if m.textarea.Value() != "/exit" {
		t.Errorf("after tab, value = %q, want /exit", m.textarea.Value())
	}
}

func TestChatModelThinkingState(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	// turn on thinking with custom message
	m2, cmd := m.Update(thinkingMsg{on: true, message: "running tools..."})
	cm := m2.(*chatModel)
	if !cm.thinking {
		t.Error("thinking should be true")
	}
	if cm.thinkingMessage != "running tools..." {
		t.Errorf("thinkingMessage = %q, want running tools...", cm.thinkingMessage)
	}
	if cmd == nil {
		t.Error("expected activity refresh command")
	}

	// turn off thinking
	m3, _ := cm.Update(thinkingMsg{on: false})
	cm = m3.(*chatModel)
	if cm.thinking {
		t.Error("thinking should be false")
	}
	if cm.thinkingMessage != "" {
		t.Errorf("thinkingMessage should be cleared, got %q", cm.thinkingMessage)
	}
}

func TestChatModelSubmitsInputWhileThinking(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.thinking = true
	m.textarea.SetValue("make it shorter")

	m2, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))
	cm := m2.(*chatModel)
	if cmd == nil {
		t.Fatal("expected print command after Enter while thinking")
	}
	if cm.textarea.Value() != "" {
		t.Fatalf("textarea value = %q, want reset", cm.textarea.Value())
	}
	select {
	case got := <-cm.submitted:
		if got != "make it shorter" {
			t.Fatalf("submitted = %q, want steer text", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for submitted input")
	}
}

func TestChatModelCtrlCWhileThinkingSubmitsStop(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.thinking = true

	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: 'c', Mod: tea.ModCtrl}))
	if cmd != nil {
		t.Fatalf("cmd = %#v, want nil so chat keeps running", cmd)
	}
	select {
	case got := <-m.submitted:
		if got != "/stop" {
			t.Fatalf("submitted = %q, want /stop", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for /stop")
	}
}

func TestChatModelEscWhileThinkingSubmitsStop(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.thinking = true

	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEsc}))
	if cmd != nil {
		t.Fatalf("cmd = %#v, want nil so chat keeps running", cmd)
	}
	select {
	case got := <-m.submitted:
		if got != "/stop" {
			t.Fatalf("submitted = %q, want /stop", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for /stop")
	}
}

func TestChatModelCtrlCWhileForegroundCommandCancelsItDirectly(t *testing.T) {
	sess := &chatSession{}
	commandCtx, finish := sess.beginForegroundCommand(context.Background())
	defer finish()
	m := newChatModel(sess)
	m.thinking = true

	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: 'c', Mod: tea.ModCtrl}))
	if cmd != nil {
		t.Fatalf("cmd = %#v, want nil so chat keeps running", cmd)
	}
	select {
	case <-commandCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("Ctrl+C did not cancel the foreground command")
	}
	select {
	case got := <-m.submitted:
		t.Fatalf("Ctrl+C queued %q while the command processor was blocked", got)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestChatModelEscWhileForegroundCommandCancelsItDirectly(t *testing.T) {
	sess := &chatSession{}
	commandCtx, finish := sess.beginForegroundCommand(context.Background())
	defer finish()
	m := newChatModel(sess)
	m.thinking = true

	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEsc}))
	if cmd != nil {
		t.Fatalf("cmd = %#v, want nil so chat keeps running", cmd)
	}
	select {
	case <-commandCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("Esc did not cancel the foreground command")
	}
	select {
	case got := <-m.submitted:
		t.Fatalf("Esc queued %q while the command processor was blocked", got)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestChatModelView(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	view := m.View().Content
	// View should contain the composer marker.
	if !strings.Contains(view, "❯ ") {
		t.Errorf("View should contain prompt, got:\n%s", view)
	}
	if strings.Contains(view, "Running") {
		t.Error("View should not contain running state when idle")
	}

	// when thinking
	m.thinking = true
	m.runStartedAt = time.Now()
	m.activityNow = m.runStartedAt
	view = m.View().Content
	if !strings.Contains(view, "Running") {
		t.Errorf("View should contain running state, got:\n%s", view)
	}
}

func TestChatModelDynamicHeight(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.textarea.SetWidth(40)

	// empty -> height 1
	if m.textarea.Height() != 1 {
		t.Errorf("empty height = %d, want 1", m.textarea.Height())
	}

	// 3 lines -> height 3
	m.textarea.SetValue("line1\nline2\nline3")
	if m.textarea.Height() != 3 {
		t.Errorf("3-line height = %d, want 3", m.textarea.Height())
	}

	// 10 lines -> capped at maxInputHeight
	m.textarea.SetValue("1\n2\n3\n4\n5\n6\n7\n8\n9\n10")
	if m.textarea.Height() != maxInputHeight {
		t.Errorf("10-line height = %d, want %d", m.textarea.Height(), maxInputHeight)
	}
}

func TestChatModelQuit(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	_, cmd := m.Update(quitMsg{})
	if cmd == nil {
		t.Fatal("expected quit command sequence")
	}
}

func TestChatModelAgentResult(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.thinking = true

	m2, cmd := m.Update(agentResultMsg{output: "hello from agent"})
	cm := m2.(*chatModel)
	if cm.thinking {
		t.Error("thinking should be false after result")
	}
	if cmd == nil {
		t.Error("expected tea.Println command for output")
	}
	cm.Update(transcriptPrintedMsg{})

	// error case
	m3, cmd2 := cm.Update(agentResultMsg{err: errTest})
	_ = m3.(*chatModel)
	if cmd2 == nil {
		t.Error("expected tea.Println command for error")
	}
}

func TestChatModelAgentResultCanKeepThinking(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.thinking = true

	m2, cmd := m.Update(agentResultMsg{output: "已收到", keepThinking: true})
	cm := m2.(*chatModel)
	if !cm.thinking {
		t.Fatal("thinking = false, want true for running-turn acknowledgement")
	}
	if cmd == nil {
		t.Fatal("expected tea.Println command for acknowledgement")
	}
}

func TestChatModelAgentErrorCanKeepThinking(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.thinking = true

	m2, cmd := m.Update(agentResultMsg{err: errTest, keepThinking: true})
	cm := m2.(*chatModel)
	if !cm.thinking {
		t.Fatal("thinking = false, want true for running-turn error")
	}
	if cmd == nil {
		t.Fatal("expected tea.Println command for error")
	}
}

func TestCountPasteLines(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"a", 1},
		{"a\n", 1},
		{"a\nb", 2},
		{"a\nb\n", 2},
		{"a\nb\nc", 3},
		{"\n\n\n", 3},
	}
	for _, c := range cases {
		if got := countPasteLines(c.in); got != c.want {
			t.Errorf("countPasteLines(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestChatModelPasteFoldsLargeBlock(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	pasted := "line1\nline2\nline3\nline4"
	msg := tea.PasteMsg{Content: pasted}
	m2, cmd := m.Update(msg)
	cm := m2.(*chatModel)

	if cmd != nil {
		t.Errorf("expected no command after paste fold, got %v", cmd)
	}
	wantPlaceholder := "[Pasted text #1 +4 lines]"
	if got := cm.textarea.Value(); got != wantPlaceholder {
		t.Errorf("textarea value = %q, want %q", got, wantPlaceholder)
	}
	if got := cm.pastedTexts[wantPlaceholder]; got != pasted {
		t.Errorf("pastedTexts[%q] = %q, want %q", wantPlaceholder, got, pasted)
	}
}

func TestChatModelPasteShortInline(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	// 2 lines meets the threshold — should fold into a placeholder.
	pasted := "one\ntwo"
	msg := tea.PasteMsg{Content: pasted}
	m2, _ := m.Update(msg)
	cm := m2.(*chatModel)

	wantPlaceholder := "[Pasted text #1 +2 lines]"
	if cm.textarea.Value() != wantPlaceholder {
		t.Errorf("textarea value = %q, want %q", cm.textarea.Value(), wantPlaceholder)
	}
	if got := cm.pastedTexts[wantPlaceholder]; got != pasted {
		t.Errorf("pastedTexts[%q] = %q, want %q", wantPlaceholder, got, pasted)
	}
}

func TestChatModelPasteSubmitExpands(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)

	pasted := "alpha\nbeta\ngamma\ndelta"
	m.Update(tea.PasteMsg{Content: pasted})

	// Prepend a label so we can verify mixed text + placeholder submission.
	m.textarea.SetValue("look: " + m.textarea.Value())

	m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))

	// Give the goroutine time to send.
	var sent string
	select {
	case sent = <-m.submitted:
	case <-time.After(time.Second):
		t.Fatal("expected a value on submitted channel")
	}
	want := "look: alpha\nbeta\ngamma\ndelta"
	if sent != want {
		t.Errorf("submitted = %q, want %q", sent, want)
	}

	// History stores the placeholder version, not the expanded text.
	if len(m.inputHistory) != 1 {
		t.Fatalf("inputHistory len = %d, want 1", len(m.inputHistory))
	}
	if !strings.Contains(m.inputHistory[0], "[Pasted text #1 +4 lines]") {
		t.Errorf("history[0] = %q, want placeholder", m.inputHistory[0])
	}
}

func TestExpandPastePlaceholdersExactMatch(t *testing.T) {
	sess := &chatSession{}
	m := newChatModel(sess)
	m.pastedTexts["[Pasted text #2 +3 lines]"] = "the real text"

	// Exact match expands; a similar-looking string that was never inserted
	// as a placeholder is left untouched.
	in := "see [Pasted text #99 +5 lines] and [Pasted text #2 +3 lines]"
	out := m.expandPastePlaceholders(in)
	want := "see [Pasted text #99 +5 lines] and the real text"
	if out != want {
		t.Errorf("expand = %q, want %q", out, want)
	}
}

var errTest = tea.ErrProgramKilled

func TestFormatSubmittedInput(t *testing.T) {
	t.Run("single line fills the band", func(t *testing.T) {
		got := formatSubmittedInput("hello", 40)
		lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
		if len(lines) != 3 {
			t.Fatalf("want 3 physical lines, got %d", len(lines))
		}
		if w := ansi.StringWidth(lines[1]); w != 40 {
			t.Errorf("band width = %d, want 40", w)
		}
		if stripped := ansi.Strip(lines[1]); stripped != "❯ hello"+strings.Repeat(" ", 33) {
			t.Errorf("stripped = %q", stripped)
		}
		if !strings.Contains(lines[1], "48;") {
			t.Error("band should carry a background SGR")
		}
		blank := chatUserLineStyle.Render(strings.Repeat(" ", 40))
		if lines[0] != blank || lines[2] != blank {
			t.Errorf("top and bottom padding must have the same full-width background: %q", got)
		}
		marker := chatAccentStyle.Background(chatUserLineStyle.GetBackground()).Render("❯ ")
		if !strings.Contains(marker, "38;") || !strings.Contains(marker, "48;") {
			t.Fatalf("marker must carry both blue foreground and band background: %q", marker)
		}
		want := marker + chatUserLineStyle.Render("hello"+strings.Repeat(" ", 33))
		if lines[1] != want {
			t.Errorf("marker and body must independently preserve the background: %q", lines[1])
		}
	})

	t.Run("multi line indents continuation", func(t *testing.T) {
		got := formatSubmittedInput("first\nsecond", 20)
		lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
		if len(lines) != 4 {
			t.Fatalf("want 4 physical lines, got %d", len(lines))
		}
		if stripped := ansi.Strip(lines[1]); !strings.HasPrefix(stripped, "❯ first") {
			t.Errorf("line 1 stripped = %q", stripped)
		}
		if stripped := ansi.Strip(lines[2]); !strings.HasPrefix(stripped, "  second") {
			t.Errorf("line 2 stripped = %q", stripped)
		}
	})

	t.Run("long line wraps and stays banded", func(t *testing.T) {
		// 90 content cells at 18 cells per line is exactly 5 physical lines.
		got := formatSubmittedInput(strings.Repeat("ab ", 30), 20)
		lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
		if len(lines) != 7 {
			t.Fatalf("want 7 physical lines, got %d: %v", len(lines), lines)
		}
		for i, line := range lines {
			if w := ansi.StringWidth(line); w != 20 {
				t.Errorf("line %d width = %d, want 20", i, w)
			}
		}
		if stripped := ansi.Strip(lines[1]); !strings.HasPrefix(stripped, "❯ ab ") {
			t.Errorf("line 1 stripped = %q", stripped)
		}
		if stripped := ansi.Strip(lines[2]); !strings.HasPrefix(stripped, "  ab ") {
			t.Errorf("line 2 stripped = %q", stripped)
		}
	})

	t.Run("wide content counts cells not bytes", func(t *testing.T) {
		// "你好" is 4 cells; the content area is 8, so 4 trailing spaces.
		got := formatSubmittedInput("你好", 10)
		lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
		if w := ansi.StringWidth(lines[1]); w != 10 {
			t.Errorf("band width = %d, want 10", w)
		}
		if stripped := ansi.Strip(lines[1]); stripped != "❯ 你好"+strings.Repeat(" ", 4) {
			t.Errorf("stripped = %q", stripped)
		}
	})

	t.Run("narrow width falls back", func(t *testing.T) {
		got := formatSubmittedInput("hello", -1)
		lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
		if len(lines) != 3 {
			t.Fatalf("want 3 physical lines, got %d", len(lines))
		}
		if stripped := ansi.Strip(lines[1]); stripped != "❯ hello" {
			t.Errorf("stripped = %q", stripped)
		}
	})
}

func TestFormatSubmittedInputSurvivesTranscriptWrap(t *testing.T) {
	// Padded band lines are exactly terminalWidth-1 wide, so the transcript
	// hardwrap must not re-wrap or truncate them.
	for _, input := range []string{"hello", "first\nsecond", strings.Repeat("word ", 20)} {
		got := formatSubmittedInput(input, 39)
		wrapped := wrapChatTranscript(got, 40)
		if strings.Count(got, "\n") != strings.Count(wrapped, "\n") {
			t.Errorf("input %q: transcript wrap changed the line count: %q", input, wrapped)
		}
	}
}

func TestInitialHistoryWaitsForTerminalWidth(t *testing.T) {
	m := newChatModel(nil)
	m.topic.ID = "topic"
	m.Init()
	if !m.initialHistoryPending || len(m.transcriptQueue) != 0 {
		t.Fatal("initial history must wait for terminal dimensions")
	}
	_, cmd := m.Update(tea.WindowSizeMsg{Width: 200, Height: 40})
	if cmd == nil || m.initialHistoryPending || m.width != 200 {
		t.Fatal("initial history must print after receiving terminal dimensions")
	}
	queued := len(m.transcriptQueue)
	m.Update(tea.WindowSizeMsg{Width: 240, Height: 40})
	if len(m.transcriptQueue) != queued {
		t.Fatal("resize must not print history again")
	}
}

func TestSubmittedInputMatchesComposerWidth(t *testing.T) {
	m := newChatModel(nil)
	for _, width := range []int{40, 80, 160, 240} {
		m.Update(tea.WindowSizeMsg{Width: width, Height: 40})
		frame := strings.Split(ansi.Strip(renderChatTextarea(m.textarea)), "\n")[0]
		band := wrapChatTranscript(formatSubmittedInput("hello", m.contentWidth()), width)
		for _, line := range strings.Split(strings.TrimRight(band, "\n"), "\n") {
			if got, want := ansi.StringWidth(line), ansi.StringWidth(frame); got != want || got != width-1 {
				t.Fatalf("terminal %d: band width %d, frame width %d", width, got, want)
			}
		}
	}
}
