package memory

import (
	"strings"
	"time"
)

const (
	sectionSessionSummary = "Session Summary"
	sectionTemporaryFacts = "Temporary Facts"
	sectionTasks          = "Tasks"
	sectionFollowUps      = "Follow Ups"
	sectionRelatedLinks   = "Related Links"

	sectionLongGoals = "Long-Term Goals / Projects"
	sectionLongFacts = "Key Facts"

	addedStampPrefix = "(added "
)

func ParseShortTermContent(body string) ShortTermContent {
	sections := splitSections(body)
	return ShortTermContent{
		SessionSummary: parseKVSection(sections[sectionSessionSummary]),
		TemporaryFacts: parseKVSection(sections[sectionTemporaryFacts]),
		Tasks:          parseTodoSection(sections[sectionTasks]),
		FollowUps:      parseTodoSection(sections[sectionFollowUps]),
		RelatedLinks:   parseLinkSection(sections[sectionRelatedLinks]),
	}
}

func ParseLongTermContent(body string) LongTermContent {
	sections := splitSections(body)
	return LongTermContent{
		Goals: parseKVSection(sections[sectionLongGoals]),
		Facts: parseKVSection(sections[sectionLongFacts]),
	}
}

func MergeShortTerm(existing ShortTermContent, draft SessionDraft) ShortTermContent {
	incomingSummary := normalizeKVItems(draft.SessionSummary)
	incomingFacts := normalizeKVItems(draft.TemporaryFacts)
	incomingTasks := normalizeTasks(draft.Tasks)
	incomingFollowUps := normalizeTasks(draft.FollowUps)

	return ShortTermContent{
		SessionSummary: mergeKV(existing.SessionSummary, incomingSummary),
		TemporaryFacts: mergeKV(existing.TemporaryFacts, incomingFacts),
		Tasks:          mergeTasks(existing.Tasks, incomingTasks),
		FollowUps:      mergeTasks(existing.FollowUps, incomingFollowUps),
		RelatedLinks:   mergeLinks(existing.RelatedLinks, nil),
	}
}

func MergeLongTerm(existing LongTermContent, draft PromoteDraft, now time.Time) LongTermContent {
	incomingGoals := normalizeKVItems(draft.GoalsProjects)
	incomingFacts := normalizeKVItems(draft.KeyFacts)
	date := ""
	if !now.IsZero() {
		date = now.UTC().Format("2006-01-02")
	}
	return LongTermContent{
		Goals: mergeLongTermKV(existing.Goals, incomingGoals, date),
		Facts: mergeLongTermKV(existing.Facts, incomingFacts, date),
	}
}

func BuildShortTermBody(date string, content ShortTermContent) string {
	var b strings.Builder
	b.WriteString("# ")
	b.WriteString(date)
	b.WriteString(" Short-Term Memory\n\n")

	writeKVSection(&b, sectionSessionSummary, content.SessionSummary)
	writeKVSection(&b, sectionTemporaryFacts, content.TemporaryFacts)
	writeTodoSection(&b, sectionTasks, content.Tasks)
	writeTodoSection(&b, sectionFollowUps, content.FollowUps)
	writeLinkSection(&b, sectionRelatedLinks, content.RelatedLinks)
	return strings.TrimSpace(b.String()) + "\n"
}

func BuildLongTermBody(content LongTermContent) string {
	var b strings.Builder
	b.WriteString("# Long-Term Memory\n\n")
	writeKVSection(&b, sectionLongGoals, content.Goals)
	writeKVSection(&b, sectionLongFacts, content.Facts)
	return strings.TrimSpace(b.String()) + "\n"
}

func splitSections(body string) map[string][]string {
	sections := make(map[string][]string)
	var current string
	lines := strings.Split(body, "\n")
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "## ") {
			current = strings.TrimSpace(strings.TrimPrefix(trim, "## "))
			if _, ok := sections[current]; !ok {
				sections[current] = nil
			}
			continue
		}
		if current == "" {
			continue
		}
		if trim == "" {
			continue
		}
		sections[current] = append(sections[current], trim)
	}
	return sections
}

func parseKVSection(lines []string) []KVItem {
	items := make([]KVItem, 0, len(lines))
	seen := map[string]bool{}
	for _, line := range lines {
		item, ok := parseKVLine(line)
		if !ok {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(item.Title))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		items = append(items, item)
	}
	return items
}

func parseTodoSection(lines []string) []TaskItem {
	items := make([]TaskItem, 0, len(lines))
	seen := map[string]bool{}
	for _, line := range lines {
		item, ok := parseTodoLine(line)
		if !ok {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(item.Text))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		items = append(items, item)
	}
	return items
}

func parseLinkSection(lines []string) []LinkItem {
	items := make([]LinkItem, 0, len(lines))
	seen := map[string]bool{}
	for _, line := range lines {
		item, ok := parseLinkLine(line)
		if !ok {
			continue
		}
		key := strings.TrimSpace(item.Target)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		items = append(items, item)
	}
	return items
}

func parseKVLine(line string) (KVItem, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "- **") {
		return KVItem{}, false
	}
	rest := strings.TrimPrefix(line, "- **")
	idx := strings.Index(rest, "**")
	if idx < 0 {
		return KVItem{}, false
	}
	title := strings.TrimSpace(rest[:idx])
	after := strings.TrimSpace(rest[idx+2:])
	if strings.HasPrefix(after, ":") {
		after = strings.TrimSpace(strings.TrimPrefix(after, ":"))
	}
	if title == "" && after == "" {
		return KVItem{}, false
	}
	return KVItem{Title: title, Value: after}, true
}

func parseTodoLine(line string) (TaskItem, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "- [") {
		return TaskItem{}, false
	}
	rest := strings.TrimPrefix(line, "- [")
	idx := strings.Index(rest, "]")
	if idx < 0 {
		return TaskItem{}, false
	}
	status := strings.ToLower(strings.TrimSpace(rest[:idx]))
	text := strings.TrimSpace(rest[idx+1:])
	if text == "" {
		return TaskItem{}, false
	}
	done := status == "x"
	return TaskItem{Text: text, Done: done}, true
}

func parseLinkLine(line string) (LinkItem, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "-") {
		return LinkItem{}, false
	}
	start := strings.Index(line, "[")
	mid := strings.Index(line, "](")
	end := strings.LastIndex(line, ")")
	if start < 0 || mid < 0 || end < 0 || end <= mid+1 {
		return LinkItem{}, false
	}
	text := strings.TrimSpace(line[start+1 : mid])
	target := strings.TrimSpace(line[mid+2 : end])
	if target == "" {
		return LinkItem{}, false
	}
	if text == "" {
		text = target
	}
	return LinkItem{Text: text, Target: target}, true
}

func normalizeKVItems(items []KVItem) []KVItem {
	out := make([]KVItem, 0, len(items))
	seen := map[string]bool{}
	for _, it := range items {
		title := strings.TrimSpace(it.Title)
		value := strings.TrimSpace(it.Value)
		if title == "" && value == "" {
			continue
		}
		if title == "" {
			title = "Item"
		}
		key := strings.ToLower(title)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, KVItem{Title: title, Value: value})
	}
	return out
}

func normalizeTasks(items []TaskItem) []TaskItem {
	out := make([]TaskItem, 0, len(items))
	seen := map[string]bool{}
	for _, it := range items {
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		key := strings.ToLower(text)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, TaskItem{Text: text, Done: it.Done})
	}
	return out
}

func mergeKV(existing []KVItem, incoming []KVItem) []KVItem {
	if len(incoming) == 0 {
		return existing
	}
	order := make([]KVItem, 0, len(existing)+len(incoming))
	index := map[string]int{}
	for _, it := range existing {
		key := strings.ToLower(strings.TrimSpace(it.Title))
		if key == "" {
			continue
		}
		index[key] = len(order)
		order = append(order, it)
	}
	for _, it := range incoming {
		key := strings.ToLower(strings.TrimSpace(it.Title))
		if key == "" {
			continue
		}
		if idx, ok := index[key]; ok {
			order[idx] = it
			continue
		}
		index[key] = len(order)
		order = append(order, it)
	}
	return order
}

func mergeLongTermKV(existing []KVItem, incoming []KVItem, date string) []KVItem {
	if len(incoming) == 0 {
		return existing
	}
	order := make([]KVItem, 0, len(existing)+len(incoming))
	index := map[string]int{}
	stamps := map[string]string{}
	for _, it := range existing {
		key := strings.ToLower(strings.TrimSpace(it.Title))
		if key == "" {
			continue
		}
		index[key] = len(order)
		order = append(order, it)
		if stamp, ok := extractAddedStamp(it.Value); ok {
			stamps[key] = stamp
		}
	}
	for _, it := range incoming {
		key := strings.ToLower(strings.TrimSpace(it.Title))
		if key == "" {
			continue
		}
		it.Title = strings.TrimSpace(it.Title)
		it.Value = strings.TrimSpace(it.Value)
		if idx, ok := index[key]; ok {
			if it.Value == "" {
				it.Value = strings.TrimSpace(order[idx].Value)
			}
			if !hasAddedStamp(it.Value) {
				if stamp, ok := stamps[key]; ok {
					it.Value = appendAddedStamp(it.Value, stamp)
				}
			}
			order[idx] = it
			continue
		}
		if !hasAddedStamp(it.Value) && strings.TrimSpace(date) != "" {
			it.Value = appendAddedStamp(it.Value, formatAddedStamp(date))
		}
		index[key] = len(order)
		order = append(order, it)
	}
	return order
}

func formatAddedStamp(date string) string {
	date = strings.TrimSpace(date)
	if date == "" {
		return ""
	}
	return addedStampPrefix + date + ")"
}

func appendAddedStamp(value string, stamp string) string {
	value = strings.TrimSpace(value)
	stamp = strings.TrimSpace(stamp)
	if stamp == "" || hasAddedStamp(value) {
		return value
	}
	if value == "" {
		return stamp
	}
	return value + " " + stamp
}

func hasAddedStamp(value string) bool {
	_, ok := extractAddedStamp(value)
	return ok
}

func extractAddedStamp(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	if !strings.HasSuffix(lower, ")") {
		return "", false
	}
	prefix := strings.ToLower(addedStampPrefix)
	idx := strings.LastIndex(lower, prefix)
	if idx < 0 {
		return "", false
	}
	stamp := strings.TrimSpace(trimmed[idx:])
	if !strings.HasPrefix(strings.ToLower(stamp), prefix) || !strings.HasSuffix(stamp, ")") {
		return "", false
	}
	inner := strings.TrimSpace(stamp[len(addedStampPrefix) : len(stamp)-1])
	if !isDateYYYYMMDD(inner) {
		return "", false
	}
	return stamp, true
}

func isDateYYYYMMDD(val string) bool {
	if len(val) != 10 {
		return false
	}
	for i, r := range val {
		switch i {
		case 4, 7:
			if r != '-' {
				return false
			}
		default:
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func mergeTasks(existing []TaskItem, incoming []TaskItem) []TaskItem {
	if len(incoming) == 0 {
		return existing
	}
	order := make([]TaskItem, 0, len(existing)+len(incoming))
	index := map[string]int{}
	for _, it := range existing {
		key := strings.ToLower(strings.TrimSpace(it.Text))
		if key == "" {
			continue
		}
		index[key] = len(order)
		order = append(order, it)
	}
	for _, it := range incoming {
		key := strings.ToLower(strings.TrimSpace(it.Text))
		if key == "" {
			continue
		}
		if idx, ok := index[key]; ok {
			order[idx] = it
			continue
		}
		index[key] = len(order)
		order = append(order, it)
	}
	return order
}

func mergeLinks(existing []LinkItem, incoming []LinkItem) []LinkItem {
	order := make([]LinkItem, 0, len(existing)+len(incoming))
	index := map[string]int{}
	for _, it := range existing {
		key := strings.TrimSpace(it.Target)
		if key == "" {
			continue
		}
		index[key] = len(order)
		order = append(order, it)
	}
	for _, it := range incoming {
		key := strings.TrimSpace(it.Target)
		if key == "" {
			continue
		}
		if idx, ok := index[key]; ok {
			order[idx] = it
			continue
		}
		index[key] = len(order)
		order = append(order, it)
	}
	return order
}

func writeKVSection(b *strings.Builder, title string, items []KVItem) {
	b.WriteString("## ")
	b.WriteString(title)
	b.WriteString("\n")
	for _, it := range items {
		if strings.TrimSpace(it.Title) == "" && strings.TrimSpace(it.Value) == "" {
			continue
		}
		b.WriteString("- **")
		b.WriteString(strings.TrimSpace(it.Title))
		b.WriteString("**: ")
		b.WriteString(strings.TrimSpace(it.Value))
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

func writeTodoSection(b *strings.Builder, title string, items []TaskItem) {
	b.WriteString("## ")
	b.WriteString(title)
	b.WriteString("\n")
	for _, it := range items {
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		if it.Done {
			b.WriteString("- [x] ")
		} else {
			b.WriteString("- [ ] ")
		}
		b.WriteString(text)
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

func writeLinkSection(b *strings.Builder, title string, items []LinkItem) {
	b.WriteString("## ")
	b.WriteString(title)
	b.WriteString("\n")
	for _, it := range items {
		text := strings.TrimSpace(it.Text)
		target := strings.TrimSpace(it.Target)
		if target == "" {
			continue
		}
		if text == "" {
			text = target
		}
		b.WriteString("- [")
		b.WriteString(text)
		b.WriteString("](")
		b.WriteString(target)
		b.WriteString(")\n")
	}
	b.WriteString("\n")
}
