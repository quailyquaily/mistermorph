package coderterm

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

var pastedContentOpen = regexp.MustCompile(`<pasted_content id="([^"]*)">`)

// A <task-notification> reports background work by its task ID: an agent's ID, a command's
// background task ID. A later report of the same agent carries no tool call's ID, so the task ID
// is the one to go by.
var (
	taskNotification   = regexp.MustCompile(`<task-notification>[\s\S]*?</task-notification>`)
	taskNotificationID = regexp.MustCompile(`<task-id>([^<]+)</task-id>`)
)

// An agent that stops while work it put in the background still runs reports at once, with an
// interim result, and reports again when it has finished. Claude Code marks the first report only
// in its wording.
var taskNotificationInterim = []string{"is waiting on its own background work", "background work of its own still running"}

// unwrapPastedContent undoes the wrapper newer Claude Code versions record around pasted
// input: "\n\n<pasted_content id=\"x\">\n…\n</pasted_content id=\"x\">\n".
func unwrapPastedContent(text string) string {
	var b strings.Builder
	for {
		m := pastedContentOpen.FindStringSubmatchIndex(text)
		if m == nil {
			break
		}
		closeTag := "</pasted_content id=\"" + text[m[2]:m[3]] + "\">"
		end := strings.Index(text[m[1]:], closeTag)
		if end < 0 {
			break
		}
		b.WriteString(text[:m[0]])
		inner := text[m[1] : m[1]+end]
		inner = strings.TrimPrefix(inner, "\n")
		inner = strings.TrimSuffix(inner, "\n")
		b.WriteString(inner)
		text = text[m[1]+end+len(closeTag):]
	}
	b.WriteString(text)
	return strings.TrimSpace(b.String())
}

// claudeTranscript only reads new user/assistant text. Tool output is deliberately ignored.
type claudeTranscript struct {
	path            string
	offset          int64
	user, assistant string
	expected        string
	messageID       string
	complete        bool
	failure         string
	// background holds, by task ID, the work this turn left running that Claude Code wakes up
	// for when it ends: agents it launched, and commands it moved to the background after they ran
	// past their timeout. Claude ends its turn while they run and takes a new one when each reports,
	// so the task is not done until they have. ended holds the reports seen before their launch.
	background, ended map[string]bool
}

// backgroundLaunch is what a tool result records when its work goes on in the background.
type backgroundLaunch struct {
	IsAsync          bool   `json:"isAsync"`          // an agent: status "async_launched"
	AgentID          string `json:"agentId"`          // its task ID
	BackgroundTaskID string `json:"backgroundTaskId"` // a command, and its task ID
	TimedOutAfterMs  int64  `json:"timedOutAfterMs"`  // moved there after its timeout
}

// waitsFor leaves out commands Claude ran in the background on purpose: a server or a watcher
// may never end, and Claude ends a turn around them as finished.
func (b backgroundLaunch) waitsFor() bool {
	return b.IsAsync || (b.BackgroundTaskID != "" && b.TimedOutAfterMs > 0)
}

// taskID is the ID its task notifications carry.
func (b backgroundLaunch) taskID() string {
	if b.IsAsync {
		return b.AgentID
	}
	return b.BackgroundTaskID
}

// noteEnded takes the background work a task notification reports as ended.
func (r *claudeTranscript) noteEnded(text string) {
	for _, note := range taskNotification.FindAllString(text, -1) {
		m := taskNotificationID.FindStringSubmatch(note)
		if m == nil {
			continue
		}
		id := strings.TrimSpace(m[1])
		interim := false
		for _, mark := range taskNotificationInterim {
			interim = interim || strings.Contains(note, mark)
		}
		if r.background[id] {
			if !interim {
				delete(r.background, id)
			}
			// Claude takes a turn for the report, so a turn that ended before it is not the last.
			r.complete = false
		} else if r.user != "" && !interim {
			if r.ended == nil {
				r.ended = map[string]bool{}
			}
			r.ended[id] = true
		}
	}
}

func (r *claudeTranscript) noteLaunched(result json.RawMessage) {
	if len(result) == 0 || result[0] != '{' {
		return
	}
	var launch backgroundLaunch
	if json.Unmarshal(result, &launch) != nil || !launch.waitsFor() {
		return
	}
	id := launch.taskID()
	if id == "" || r.ended[id] {
		return
	}
	if r.background == nil {
		r.background = map[string]bool{}
	}
	r.background[id] = true
}

func (r *claudeTranscript) read() error {
	f, err := os.Open(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Seek(r.offset, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var entry struct {
			Type      string          `json:"type"`
			Operation string          `json:"operation"`
			Queued    json.RawMessage `json:"content"`
			Origin    string          `json:"turnOrigin"`
			ToolUse   json.RawMessage `json:"toolUseResult"`
			Sidechain bool            `json:"isSidechain"`
			Meta      bool            `json:"isMeta"`
			Summary   bool            `json:"isCompactSummary"`
			APIError  bool            `json:"isApiErrorMessage"`
			Message   struct {
				ID         string          `json:"id"`
				Content    json.RawMessage `json:"content"`
				StopReason string          `json:"stop_reason"`
			} `json:"message"`
		}
		if err := json.Unmarshal(line, &entry); err != nil {
			return err
		}
		r.offset += int64(len(line))
		// Claude Code queues each report of ended background work, whether it then starts a
		// turn or joins the one running.
		if entry.Type == "queue-operation" && entry.Operation == "enqueue" {
			var queued string
			if json.Unmarshal(entry.Queued, &queued) == nil {
				r.noteEnded(queued)
			}
			continue
		}
		if entry.Sidechain || entry.Meta || entry.Summary || (entry.Type != "user" && entry.Type != "assistant") {
			continue
		}
		var text string
		if len(entry.Message.Content) == 0 {
			continue
		}
		if entry.Message.Content[0] == '"' {
			if err := json.Unmarshal(entry.Message.Content, &text); err != nil {
				return err
			}
		} else {
			var blocks []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
				return err
			}
			var parts []string
			for _, block := range blocks {
				if block.Type == "text" {
					parts = append(parts, block.Text)
				}
				if block.Type == "tool_result" && r.user != "" {
					r.noteLaunched(entry.ToolUse)
				}
			}
			text = strings.Join(parts, "\n")
		}
		if entry.Type == "user" && entry.Origin == "task_notification" {
			// A report of ended background work, never the task; its turn follows.
			r.noteEnded(text)
			continue
		}
		if entry.Type == "user" {
			if r.user == "" && text != "" {
				if r.expected != "" && unwrapPastedContent(text) != r.expected {
					return fmt.Errorf("Claude transcript does not match the submitted task")
				}
				r.user = text
			}
			continue
		}
		// Never return an assistant record preceding this call's user input.
		if r.user == "" {
			continue
		}
		if entry.APIError {
			r.failure = text
			continue
		}
		if entry.Message.ID == "" || entry.Message.ID != r.messageID {
			r.messageID = entry.Message.ID
			r.assistant = ""
			r.complete = false
		}
		if text != "" {
			if r.assistant != "" {
				r.assistant += "\n\n"
			}
			r.assistant += text
		}
		r.complete = entry.Message.StopReason == "end_turn" || entry.Message.StopReason == "stop_sequence"
	}
}
