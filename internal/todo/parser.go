package todo

import (
	"bufio"
	"fmt"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
	"gopkg.in/yaml.v3"
)

type fileFrontmatter struct {
	CreatedAt string `yaml:"created_at"`
	UpdatedAt string `yaml:"updated_at"`
	OpenCount *int   `yaml:"open_count,omitempty"`
	DoneCount *int   `yaml:"done_count,omitempty"`
}

func ParseWIP(raw string) (WIPFile, error) {
	fm, body, _, err := parseFrontmatter(raw)
	if err != nil {
		return WIPFile{}, err
	}
	lines := parseEntryLines(body, false)
	out := WIPFile{
		CreatedAt: strings.TrimSpace(fm.CreatedAt),
		UpdatedAt: strings.TrimSpace(fm.UpdatedAt),
		Entries:   lines,
	}
	if fm.OpenCount != nil {
		out.OpenCount = *fm.OpenCount
	}
	out.OpenCount = len(out.Entries)
	return out, nil
}

func ParseDONE(raw string) (DONEFile, error) {
	fm, body, _, err := parseFrontmatter(raw)
	if err != nil {
		return DONEFile{}, err
	}
	lines := parseEntryLines(body, true)
	out := DONEFile{
		CreatedAt: strings.TrimSpace(fm.CreatedAt),
		UpdatedAt: strings.TrimSpace(fm.UpdatedAt),
		Entries:   lines,
	}
	if fm.DoneCount != nil {
		out.DoneCount = *fm.DoneCount
	}
	out.DoneCount = len(out.Entries)
	return out, nil
}

func RenderWIP(file WIPFile) string {
	file.OpenCount = len(file.Entries)
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(`created_at: "`)
	b.WriteString(strings.TrimSpace(file.CreatedAt))
	b.WriteString("\"\n")
	b.WriteString(`updated_at: "`)
	b.WriteString(strings.TrimSpace(file.UpdatedAt))
	b.WriteString("\"\n")
	b.WriteString("open_count: ")
	b.WriteString(strconv.Itoa(file.OpenCount))
	b.WriteString("\n")
	b.WriteString("---\n\n")
	b.WriteString(HeaderWIP)
	b.WriteString("\n\n")
	for _, item := range file.Entries {
		line := renderWIPEntryLine(item)
		if strings.TrimSpace(line) == "" {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func RenderDONE(file DONEFile) string {
	file.DoneCount = len(file.Entries)
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(`created_at: "`)
	b.WriteString(strings.TrimSpace(file.CreatedAt))
	b.WriteString("\"\n")
	b.WriteString(`updated_at: "`)
	b.WriteString(strings.TrimSpace(file.UpdatedAt))
	b.WriteString("\"\n")
	b.WriteString("done_count: ")
	b.WriteString(strconv.Itoa(file.DoneCount))
	b.WriteString("\n")
	b.WriteString("---\n\n")
	b.WriteString(HeaderDONE)
	b.WriteString("\n\n")
	for _, item := range file.Entries {
		line := renderDONEEntryLine(item)
		if strings.TrimSpace(line) == "" {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func ParseEntryFromInput(raw string, now string) (Entry, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Entry{}, fmt.Errorf("content is required")
	}
	if done, ok := parseDONEEntryLine(raw); ok {
		done.Done = false
		done.DoneAt = ""
		done.CreatedAt = strings.TrimSpace(now)
		return done, nil
	}
	if wip, ok := parseWIPEntryLine(raw); ok {
		wip.Done = false
		wip.DoneAt = ""
		wip.CreatedAt = strings.TrimSpace(now)
		return wip, nil
	}
	raw = strings.TrimPrefix(raw, "- [ ]")
	raw = strings.TrimPrefix(raw, "- [x]")
	raw = strings.TrimPrefix(raw, "- [X]")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Entry{}, fmt.Errorf("content is required")
	}
	return Entry{
		Done:      false,
		CreatedAt: strings.TrimSpace(now),
		ChatID:    "",
		Content:   raw,
	}, nil
}

func parseFrontmatter(raw string) (fileFrontmatter, string, bool, error) {
	sc := bufio.NewScanner(strings.NewReader(raw))
	if !sc.Scan() {
		return fileFrontmatter{}, raw, false, nil
	}
	if strings.TrimSpace(sc.Text()) != "---" {
		return fileFrontmatter{}, raw, false, nil
	}
	var yamlLines []string
	var bodyLines []string
	foundEnd := false
	for sc.Scan() {
		line := sc.Text()
		if !foundEnd {
			if strings.TrimSpace(line) == "---" {
				foundEnd = true
				continue
			}
			yamlLines = append(yamlLines, line)
			continue
		}
		bodyLines = append(bodyLines, line)
	}
	if !foundEnd {
		return fileFrontmatter{}, raw, false, nil
	}
	var fm fileFrontmatter
	if err := yaml.Unmarshal([]byte(strings.Join(yamlLines, "\n")), &fm); err != nil {
		return fileFrontmatter{}, strings.Join(bodyLines, "\n"), false, nil
	}
	return fm, strings.Join(bodyLines, "\n"), true, nil
}

func parseEntryLines(body string, done bool) []Entry {
	if strings.TrimSpace(body) == "" {
		return nil
	}
	lines := strings.Split(body, "\n")
	out := make([]Entry, 0, len(lines))
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		if done {
			if item, ok := parseDONEEntryLine(line); ok {
				out = append(out, item)
			}
			continue
		}
		if item, ok := parseWIPEntryLine(line); ok {
			out = append(out, item)
		}
	}
	return out
}

func parseWIPEntryLine(line string) (Entry, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "- [ ] ") {
		return Entry{}, false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(line, "- [ ] "))
	metaRaw, content, ok := entryutil.SplitMetadataAndContent(rest)
	if !ok {
		return Entry{}, false
	}
	meta, ok := parseEntryMetadata(metaRaw)
	if !ok || content == "" {
		return Entry{}, false
	}
	createdAt, ok := meta["Created"]
	if !ok || !validTimestamp(createdAt) {
		return Entry{}, false
	}
	if _, exists := meta["Done"]; exists {
		return Entry{}, false
	}
	chatID := ""
	if rawChatID, exists := meta["ChatID"]; exists {
		chatID = normalizeEntryChatID(rawChatID)
		if !isValidTODOChatID(chatID) {
			return Entry{}, false
		}
	}
	return Entry{
		Done:      false,
		CreatedAt: createdAt,
		ChatID:    chatID,
		Content:   content,
	}, true
}

func parseDONEEntryLine(line string) (Entry, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "- [x] ") {
		return Entry{}, false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(line, "- [x] "))
	metaRaw, content, ok := entryutil.SplitMetadataAndContent(rest)
	if !ok {
		return Entry{}, false
	}
	meta, ok := parseEntryMetadata(metaRaw)
	if !ok || content == "" {
		return Entry{}, false
	}
	createdAt, ok := meta["Created"]
	if !ok || !validTimestamp(createdAt) {
		return Entry{}, false
	}
	doneAt, ok := meta["Done"]
	if !ok || !validTimestamp(doneAt) {
		return Entry{}, false
	}
	chatID := ""
	if rawChatID, exists := meta["ChatID"]; exists {
		chatID = normalizeEntryChatID(rawChatID)
		if !isValidTODOChatID(chatID) {
			return Entry{}, false
		}
	}
	return Entry{
		Done:      true,
		CreatedAt: createdAt,
		DoneAt:    doneAt,
		ChatID:    chatID,
		Content:   content,
	}, true
}

func renderWIPEntryLine(item Entry) string {
	content := strings.TrimSpace(item.Content)
	createdAt := strings.TrimSpace(item.CreatedAt)
	if content == "" || !validTimestamp(createdAt) {
		return ""
	}
	meta := []string{entryutil.FormatMetadataTuple("Created", createdAt)}
	chatID := normalizeEntryChatID(item.ChatID)
	if chatID != "" {
		if !isValidTODOChatID(chatID) {
			return ""
		}
		meta = append(meta, entryutil.FormatMetadataTuple("ChatID", chatID))
	}
	return "- [ ] " + strings.Join(meta, ", ") + " | " + content
}

func renderDONEEntryLine(item Entry) string {
	content := strings.TrimSpace(item.Content)
	createdAt := strings.TrimSpace(item.CreatedAt)
	doneAt := strings.TrimSpace(item.DoneAt)
	if content == "" || !validTimestamp(createdAt) || !validTimestamp(doneAt) {
		return ""
	}
	meta := []string{
		entryutil.FormatMetadataTuple("Created", createdAt),
		entryutil.FormatMetadataTuple("Done", doneAt),
	}
	chatID := normalizeEntryChatID(item.ChatID)
	if chatID != "" {
		if !isValidTODOChatID(chatID) {
			return ""
		}
		meta = append(meta, entryutil.FormatMetadataTuple("ChatID", chatID))
	}
	return "- [x] " + strings.Join(meta, ", ") + " | " + content
}

func parseEntryMetadata(raw string) (map[string]string, bool) {
	out, ok := entryutil.ParseMetadataTuples(raw)
	if !ok {
		return nil, false
	}
	for key := range out {
		switch key {
		case "Created", "Done", "ChatID":
			continue
		default:
			return nil, false
		}
	}
	return out, true
}
