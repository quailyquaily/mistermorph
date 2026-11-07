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
			Type      string `json:"type"`
			Sidechain bool   `json:"isSidechain"`
			Meta      bool   `json:"isMeta"`
			Summary   bool   `json:"isCompactSummary"`
			APIError  bool   `json:"isApiErrorMessage"`
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
			}
			text = strings.Join(parts, "\n")
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
