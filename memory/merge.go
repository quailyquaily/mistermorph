package memory

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
)

const (
	sectionSummary = "Summary"

	sectionLongGoals = "Long-Term Goals / Projects"
	sectionLongFacts = "Key Facts"
)

func ParseShortTermContent(body string) ShortTermContent {
	return ShortTermContent{SummaryItems: parseSummarySection(body)}
}

func ParseLongTermContent(body string) LongTermContent {
	sections := splitSections(body)
	return LongTermContent{
		Goals: parseLongTermGoals(sections[sectionLongGoals]),
		Facts: parseKVSection(sections[sectionLongFacts]),
	}
}

func MergeShortTerm(existing ShortTermContent, draft SessionDraft, createdAt string) ShortTermContent {
	incoming := makeSummaryItems(draft.SummaryItems, createdAt)
	merged := make([]SummaryItem, 0, len(incoming)+len(existing.SummaryItems))
	merged = append(merged, incoming...)
	merged = append(merged, existing.SummaryItems...)
	return NormalizeShortTermContent(ShortTermContent{SummaryItems: merged})
}

func MergeLongTerm(existing LongTermContent, draft PromoteDraft, now time.Time) LongTermContent {
	createdAt := ""
	if !now.IsZero() {
		createdAt = now.UTC().Format(entryutil.TimestampLayout)
	}
	incomingGoals := makeGoalsFromDraft(draft.GoalsProjects, createdAt)
	incomingFacts := normalizeKVItems(draft.KeyFacts)
	return LongTermContent{
		Goals: mergeLongTermGoals(existing.Goals, incomingGoals),
		Facts: mergeLongTermFacts(existing.Facts, incomingFacts),
	}
}

func NormalizeShortTermContent(content ShortTermContent) ShortTermContent {
	if len(content.SummaryItems) == 0 {
		content.SummaryItems = nil
		return content
	}
	content.SummaryItems = normalizeSummaryItems(content.SummaryItems)
	return content
}

func BuildShortTermBody(content ShortTermContent) string {
	var b strings.Builder
	b.WriteString("# ")
	b.WriteString(sectionSummary)
	b.WriteString("\n\n")
	for _, item := range normalizeSummaryItems(content.SummaryItems) {
		line := renderSummaryLine(item)
		if strings.TrimSpace(line) == "" {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String()) + "\n"
}

func SemanticDedupeSummaryItems(ctx context.Context, items []SummaryItem, resolver entryutil.SemanticResolver) ([]SummaryItem, error) {
	items = normalizeSummaryItems(items)
	if len(items) <= 1 {
		return append([]SummaryItem{}, items...), nil
	}
	entries := make([]entryutil.SemanticItem, 0, len(items))
	for _, item := range items {
		entries = append(entries, entryutil.SemanticItem{
			CreatedAt: strings.TrimSpace(item.Created),
			Content:   strings.TrimSpace(item.Content),
		})
	}
	keepIndices, err := entryutil.ResolveKeepIndices(ctx, entries, resolver)
	if err != nil {
		return nil, err
	}
	keep := make(map[int]bool, len(keepIndices))
	for _, idx := range keepIndices {
		keep[idx] = true
	}
	out := make([]SummaryItem, 0, len(keep))
	for i, item := range items {
		if !keep[i] {
			continue
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("semantic dedupe removed all summary items")
	}
	return out, nil
}

func parseSummarySection(body string) []SummaryItem {
	if strings.TrimSpace(body) == "" {
		return nil
	}
	lines := strings.Split(body, "\n")
	inSummary := false
	out := make([]SummaryItem, 0, len(lines))
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			header := strings.TrimSpace(strings.TrimLeft(line, "#"))
			inSummary = strings.EqualFold(header, sectionSummary)
			continue
		}
		if !inSummary {
			continue
		}
		item, ok := parseSummaryLine(line)
		if !ok {
			continue
		}
		out = append(out, item)
	}
	return normalizeSummaryItems(out)
}

func makeSummaryItems(contents []string, createdAt string) []SummaryItem {
	createdAt = strings.TrimSpace(createdAt)
	out := make([]SummaryItem, 0, len(contents))
	for _, raw := range contents {
		content := strings.TrimSpace(raw)
		if content == "" {
			continue
		}
		out = append(out, SummaryItem{
			Created: createdAt,
			Content: content,
		})
	}
	return normalizeSummaryItems(out)
}

func normalizeSummaryItems(items []SummaryItem) []SummaryItem {
	if len(items) == 0 {
		return nil
	}
	out := make([]SummaryItem, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		created := strings.TrimSpace(item.Created)
		content := strings.TrimSpace(item.Content)
		if created == "" || content == "" {
			continue
		}
		if !entryutil.IsValidTimestamp(created) {
			continue
		}
		key := strings.ToLower(created + "|" + content)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, SummaryItem{Created: created, Content: content})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseSummaryLine(line string) (SummaryItem, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "- ") {
		return SummaryItem{}, false
	}
	metaRaw, content, ok := entryutil.SplitMetadataAndContent(strings.TrimSpace(strings.TrimPrefix(line, "- ")))
	if !ok {
		return SummaryItem{}, false
	}
	meta, ok := entryutil.ParseMetadataTuples(metaRaw)
	if !ok || len(meta) != 1 {
		return SummaryItem{}, false
	}
	created := strings.TrimSpace(meta["Created"])
	content = strings.TrimSpace(content)
	if created == "" || content == "" {
		return SummaryItem{}, false
	}
	if !entryutil.IsValidTimestamp(created) {
		return SummaryItem{}, false
	}
	return SummaryItem{
		Created: created,
		Content: content,
	}, true
}

func renderSummaryLine(item SummaryItem) string {
	created := strings.TrimSpace(item.Created)
	content := strings.TrimSpace(item.Content)
	if created == "" || content == "" {
		return ""
	}
	if !entryutil.IsValidTimestamp(created) {
		return ""
	}
	return "- " + entryutil.FormatMetadataTuple("Created", created) + " | " + content
}

func BuildLongTermBody(content LongTermContent) string {
	var b strings.Builder
	b.WriteString("# Long-Term Memory\n\n")
	writeLongTermGoalsSection(&b, sectionLongGoals, content.Goals)
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
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if item, ok := parseKVLine(line); ok {
			items = append(items, item)
		}
	}

	out := make([]KVItem, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		key := strings.ToLower(strings.TrimSpace(item.Title))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, item)
	}
	return out
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

func makeGoalsFromDraft(items []string, createdAt string) []LongTermGoal {
	createdAt = strings.TrimSpace(createdAt)
	seen := make(map[string]bool, len(items))
	out := make([]LongTermGoal, 0, len(items))
	for _, raw := range items {
		content := strings.TrimSpace(raw)
		if strings.TrimSpace(content) == "" {
			continue
		}
		key := strings.ToLower(content)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, LongTermGoal{
			Done:    false,
			Created: createdAt,
			Content: content,
		})
	}
	return normalizeLongTermGoals(out)
}

func mergeLongTermGoals(existing []LongTermGoal, incoming []LongTermGoal) []LongTermGoal {
	existing = normalizeLongTermGoals(existing)
	incoming = normalizeLongTermGoals(incoming)
	if len(incoming) == 0 {
		return existing
	}
	out := append([]LongTermGoal{}, existing...)
	index := make(map[string]int, len(out))
	for i, item := range out {
		index[strings.ToLower(strings.TrimSpace(item.Content))] = i
	}
	for _, item := range incoming {
		key := strings.ToLower(strings.TrimSpace(item.Content))
		if key == "" {
			continue
		}
		if idx, ok := index[key]; ok {
			// Preserve completion state when the same goal is re-promoted.
			if !out[idx].Done && item.Done {
				out[idx].Done = true
				out[idx].DoneAt = strings.TrimSpace(item.DoneAt)
			}
			continue
		}
		index[key] = len(out)
		out = append(out, item)
	}
	return out
}

func mergeLongTermFacts(existing []KVItem, incoming []KVItem) []KVItem {
	existing = normalizeKVItems(existing)
	incoming = normalizeKVItems(incoming)
	if len(incoming) == 0 {
		return existing
	}
	out := append([]KVItem{}, existing...)
	index := make(map[string]int, len(out))
	for i, item := range out {
		index[strings.ToLower(strings.TrimSpace(item.Title))] = i
	}
	for _, item := range incoming {
		key := strings.ToLower(strings.TrimSpace(item.Title))
		if key == "" {
			continue
		}
		if idx, ok := index[key]; ok {
			out[idx] = item
			continue
		}
		index[key] = len(out)
		out = append(out, item)
	}
	return out
}

func parseLongTermGoals(lines []string) []LongTermGoal {
	items := make([]LongTermGoal, 0, len(lines))
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		item, ok := parseLongTermGoalLine(line)
		if !ok {
			continue
		}
		items = append(items, item)
	}
	return normalizeLongTermGoals(items)
}

func parseLongTermGoalLine(line string) (LongTermGoal, bool) {
	line = strings.TrimSpace(line)
	markDone := false
	var rest string
	switch {
	case strings.HasPrefix(line, "- [ ] "):
		rest = strings.TrimSpace(strings.TrimPrefix(line, "- [ ] "))
	case strings.HasPrefix(line, "- [x] "):
		markDone = true
		rest = strings.TrimSpace(strings.TrimPrefix(line, "- [x] "))
	case strings.HasPrefix(line, "- [X] "):
		markDone = true
		rest = strings.TrimSpace(strings.TrimPrefix(line, "- [X] "))
	default:
		return LongTermGoal{}, false
	}
	metaRaw, content, ok := entryutil.SplitMetadataAndContent(rest)
	if !ok {
		return LongTermGoal{}, false
	}
	meta, ok := entryutil.ParseMetadataTuples(metaRaw)
	if !ok {
		return LongTermGoal{}, false
	}
	for key := range meta {
		switch key {
		case "Created", "Done":
			continue
		default:
			return LongTermGoal{}, false
		}
	}
	created := strings.TrimSpace(meta["Created"])
	doneAt := strings.TrimSpace(meta["Done"])
	content = strings.TrimSpace(content)
	if created == "" || content == "" {
		return LongTermGoal{}, false
	}
	if !entryutil.IsValidTimestamp(created) || content == "" {
		return LongTermGoal{}, false
	}
	if doneAt != "" && !entryutil.IsValidTimestamp(doneAt) {
		return LongTermGoal{}, false
	}
	if markDone && doneAt == "" {
		return LongTermGoal{}, false
	}
	done := markDone
	if doneAt != "" {
		done = true
	}
	return LongTermGoal{
		Done:    done,
		Created: created,
		DoneAt:  doneAt,
		Content: content,
	}, true
}

func normalizeLongTermGoals(items []LongTermGoal) []LongTermGoal {
	if len(items) == 0 {
		return nil
	}
	out := make([]LongTermGoal, 0, len(items))
	index := make(map[string]int, len(items))
	for _, item := range items {
		created := strings.TrimSpace(item.Created)
		doneAt := strings.TrimSpace(item.DoneAt)
		content := strings.TrimSpace(item.Content)
		done := item.Done
		if !entryutil.IsValidTimestamp(created) || content == "" {
			continue
		}
		if doneAt != "" {
			if !entryutil.IsValidTimestamp(doneAt) {
				continue
			}
			done = true
		}
		key := strings.ToLower(content)
		normalized := LongTermGoal{
			Done:    done,
			Created: created,
			DoneAt:  doneAt,
			Content: content,
		}
		if idx, ok := index[key]; ok {
			if !out[idx].Done && normalized.Done {
				out[idx] = normalized
			}
			continue
		}
		index[key] = len(out)
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func writeLongTermGoalsSection(b *strings.Builder, title string, goals []LongTermGoal) {
	b.WriteString("## ")
	b.WriteString(title)
	b.WriteString("\n")
	for _, goal := range normalizeLongTermGoals(goals) {
		line := renderLongTermGoalLine(goal)
		if strings.TrimSpace(line) == "" {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

func renderLongTermGoalLine(goal LongTermGoal) string {
	goal = normalizeLongTermGoal(goal)
	if strings.TrimSpace(goal.Content) == "" || !entryutil.IsValidTimestamp(goal.Created) {
		return ""
	}
	mark := " "
	if goal.Done {
		mark = "x"
	}
	meta := []string{
		entryutil.FormatMetadataTuple("Created", goal.Created),
	}
	if goal.Done {
		if !entryutil.IsValidTimestamp(goal.DoneAt) {
			return ""
		}
		meta = append(meta, entryutil.FormatMetadataTuple("Done", goal.DoneAt))
	}
	return "- [" + mark + "] " + strings.Join(meta, ", ") + " | " + goal.Content
}

func normalizeLongTermGoal(goal LongTermGoal) LongTermGoal {
	goal.Created = strings.TrimSpace(goal.Created)
	goal.DoneAt = strings.TrimSpace(goal.DoneAt)
	goal.Content = strings.TrimSpace(goal.Content)
	if goal.DoneAt != "" {
		goal.Done = true
	}
	return goal
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
