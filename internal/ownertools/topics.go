package ownertools

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pagination"
)

const (
	topicSearchDefault = 10
	topicSearchMax     = 30
	topicReadDefault   = 5
	topicReadMax       = 20
	// topicSearchScanMax bounds how many tasks one search reads; past it the results say partial.
	topicSearchScanMax = 20000
	// pageSize is how many topics or tasks one store page asks for.
	pageSize = 200

	excerptRunes      = 240
	readMessageRunes  = 2000
	readReplyRunes    = 4000
	readErrorRunes    = 500
	readFilesPerTask  = 20
	readTagsPerTopic  = 20
	topicKindTopic    = "topic"
	topicKindTodo     = "todo"
	topicKindAgent    = "agent_link"
	topicKindRuntime  = "awareness"
	matchedTitle      = "title"
	matchedTags       = "tags"
	matchedMessages   = "messages"
	searchQueryMaxLen = 500
)

func topicKind(id string) string {
	switch {
	case daemonruntime.IsCronTopicID(id):
		return topicKindTodo
	case daemonruntime.IsAgentLinkTopicID(id):
		return topicKindAgent
	case strings.TrimSpace(id) == daemonruntime.ConsoleAwarenessTopicID:
		return topicKindRuntime
	}
	return topicKindTopic
}

// ownerMayRead reports whether a task of the Console store is the owner's to read. Every Console
// task is the owner's; one that records another audience (none should) is skipped, so a store
// shared with another audience's runs never shows its tasks here.
func ownerMayRead(task daemonruntime.TaskInfo) bool {
	if task.Conversation == nil {
		return true
	}
	who := strings.TrimSpace(task.Conversation.Audience)
	return who == "" || who == audience.Owner().String()
}

// taskText is what was said in a task: the user's message and the reply.
func taskText(task daemonruntime.TaskInfo) (message, reply string) {
	return strings.TrimSpace(task.Task), chathistory.TaskReplyText(task)
}

func (d *Deps) topicWorkspace(ctx context.Context, topicID string) (string, string) {
	if d.TopicWorkspace == nil {
		return "", ""
	}
	dir, source, err := d.TopicWorkspace(ctx, topicID)
	if err != nil {
		return "", ""
	}
	return displayPath(dir, d.HomeDir), source
}

// eachTopic calls fn with every live topic, most recently active first, until fn returns false.
func eachTopic(store Topics, fn func(daemonruntime.TopicInfo) bool) {
	cursor := ""
	for {
		page := store.ListTopicsPage(daemonruntime.TopicListOptions{Limit: pageSize, Cursor: cursor})
		for _, topic := range page {
			if topic.DeletedAt != nil {
				continue
			}
			if !fn(topic) {
				return
			}
		}
		if len(page) < pageSize {
			return
		}
		last := page[len(page)-1]
		cursor = pagination.EncodeKeysetCursor(last.UpdatedAt, last.ID)
		if cursor == "" {
			return
		}
	}
}

// eachTask calls fn with a topic's tasks, newest first, until fn returns false.
func eachTask(store Topics, topicID string, fn func(daemonruntime.TaskInfo) bool) {
	cursor := ""
	for {
		page := store.List(daemonruntime.TaskListOptions{TopicID: topicID, Limit: pageSize, Cursor: cursor})
		for _, task := range page {
			if !ownerMayRead(task) {
				continue
			}
			if !fn(task) {
				return
			}
		}
		if len(page) < pageSize {
			return
		}
		last := page[len(page)-1]
		cursor = pagination.EncodeKeysetCursor(last.CreatedAt, last.ID)
		if cursor == "" {
			return
		}
	}
}

type topicHit struct {
	ID              string   `json:"id"`
	Title           string   `json:"title,omitempty"`
	Kind            string   `json:"kind"`
	Tags            []string `json:"tags,omitempty"`
	LastActivity    string   `json:"last_activity,omitempty"`
	Workspace       string   `json:"workspace,omitempty"`
	WorkspaceSource string   `json:"workspace_source,omitempty"`
	MatchedIn       []string `json:"matched_in,omitempty"`
	Excerpt         string   `json:"excerpt,omitempty"`
	ExcerptTaskID   string   `json:"excerpt_task_id,omitempty"`
}

type topicSearchTool struct {
	ownerTool
	deps *Deps
}

func (t *topicSearchTool) Name() string       { return TopicSearchName }
func (t *topicSearchTool) ParallelSafe() bool { return true }

func (t *topicSearchTool) Description() string {
	return "Finds the owner's Console topics (conversations) by title, tags and what was said in them: the user's messages and your replies. Every word of query must appear in the topic. " +
		"Results are the most recently active first, each with its id, title, last activity, workspace and a short excerpt where it matched. " +
		"Use it when the user refers to another conversation or earlier work you cannot see here, then read one with topic_read. Without query it lists topics by recent activity."
}

func (t *topicSearchTool) ParameterSchema() string {
	return schema(map[string]any{
		"query": prop("string", "Words that must all appear in the topic's title, tags or messages (case-insensitive). Omit to list topics."),
		"tag":   prop("string", "Only topics with this tag."),
		"limit": prop("integer", fmt.Sprintf("At most this many topics, 1-%d. Default %d.", topicSearchMax, topicSearchDefault)),
	})
}

func (t *topicSearchTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if err := checkCall(ctx, t.Name(), t.deps); err != nil {
		return "", err
	}
	if err := rejectUnknown(params, "query", "tag", "limit"); err != nil {
		return "", err
	}
	store := t.deps.Topics
	if store == nil {
		return "", errNoStore
	}
	query := stringParam(params, "query")
	if utf8.RuneCountInString(query) > searchQueryMaxLen {
		return "", fmt.Errorf("query is too long (at most %d characters)", searchQueryMaxLen)
	}
	words := strings.Fields(strings.ToLower(query))
	tag := strings.ToLower(stringParam(params, "tag"))
	limit := limitParam(params, topicSearchDefault, topicSearchMax)

	var hits []topicHit
	more, partial := false, false
	scanned := 0
	eachTopic(store, func(topic daemonruntime.TopicInfo) bool {
		if tag != "" && !hasTag(topic.Tags, tag) {
			return true
		}
		hit, ok := t.match(ctx, topic, words, &scanned, &partial)
		if !ok {
			return !partial
		}
		if len(hits) == limit {
			more = true
			return false
		}
		hits = append(hits, hit)
		return !partial
	})
	if hits == nil {
		hits = []topicHit{}
	}
	out := map[string]any{"topics": hits, "has_more": more}
	if partial {
		out["partial"] = true
		out["note"] = "The search stopped after reading its limit of messages; narrow it with more words or a tag."
	}
	return result(out)
}

// match checks one topic against the query words: its title, its tags, then its tasks newest
// first, until every word is found. The excerpt comes from the newest task that has a word.
func (t *topicSearchTool) match(ctx context.Context, topic daemonruntime.TopicInfo, words []string, scanned *int, partial *bool) (topicHit, bool) {
	hit := topicHit{
		ID:           topic.ID,
		Title:        strings.TrimSpace(topic.Title),
		Kind:         topicKind(topic.ID),
		Tags:         capStrings(topic.Tags, readTagsPerTopic),
		LastActivity: formatTime(topic.UpdatedAt),
	}
	missing := map[string]bool{}
	for _, w := range words {
		missing[w] = true
	}
	title := strings.ToLower(topic.Title)
	tags := strings.ToLower(strings.Join(topic.Tags, " "))
	for w := range missing {
		inTitle, inTags := strings.Contains(title, w), strings.Contains(tags, w)
		if inTitle {
			hit.addMatched(matchedTitle)
		}
		if inTags {
			hit.addMatched(matchedTags)
		}
		if inTitle || inTags {
			delete(missing, w)
		}
	}
	if len(words) > 0 {
		eachTask(t.deps.Topics, topic.ID, func(task daemonruntime.TaskInfo) bool {
			if *scanned >= topicSearchScanMax {
				*partial = true
				return false
			}
			*scanned++
			message, reply := taskText(task)
			lower := strings.ToLower(message + "\n" + reply)
			found := false
			for _, w := range words {
				if strings.Contains(lower, w) {
					found = true
					delete(missing, w)
				}
			}
			if found {
				hit.addMatched(matchedMessages)
				if hit.Excerpt == "" {
					hit.Excerpt = excerptAround(message+"\n"+reply, words, excerptRunes)
					hit.ExcerptTaskID = task.ID
				}
			}
			return len(missing) > 0 || hit.Excerpt == ""
		})
		if len(missing) > 0 {
			return topicHit{}, false
		}
	}
	hit.Workspace, hit.WorkspaceSource = t.deps.topicWorkspace(ctx, topic.ID)
	return hit, true
}

func (h *topicHit) addMatched(where string) {
	for _, m := range h.MatchedIn {
		if m == where {
			return
		}
	}
	h.MatchedIn = append(h.MatchedIn, where)
}

func hasTag(tags []string, tag string) bool {
	for _, t := range tags {
		if strings.EqualFold(strings.TrimSpace(t), tag) {
			return true
		}
	}
	return false
}

func capStrings(items []string, max int) []string {
	if len(items) > max {
		return append([]string(nil), items[:max]...)
	}
	return items
}

// excerptAround cuts text to about max runes around the first query word in it.
func excerptAround(text string, words []string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	lower := []rune(strings.ToLower(text))
	at := -1
	for _, w := range words {
		if i := runeIndex(lower, []rune(w)); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	if at < 0 {
		at = 0
	}
	start := at - max/3
	if start < 0 {
		start = 0
	}
	end := start + max
	if end > len(runes) {
		end = len(runes)
		start = max0(end - max)
	}
	out := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		out = "…" + out
	}
	if end < len(runes) {
		out += "…"
	}
	return out
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// runeIndex finds needle in haystack by runes, so positions match the text's runes even where
// lowercasing changed a character's byte length.
func runeIndex(haystack, needle []rune) int {
	if len(needle) == 0 || len(needle) > len(haystack) {
		return -1
	}
outer:
	for i := 0; i+len(needle) <= len(haystack); i++ {
		for j := range needle {
			if haystack[i+j] != needle[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}

type topicReadTool struct {
	ownerTool
	deps *Deps
}

func (t *topicReadTool) Name() string       { return TopicReadName }
func (t *topicReadTool) ParallelSafe() bool { return true }

func (t *topicReadTool) Description() string {
	return "Reads one of the owner's Console topics by its id (from topic_search): its conversation newest first, each turn's user message and your reply (long ones are cut), with the names of its files, and the topic's workspace. " +
		"Pass next_cursor back as cursor to read older turns."
}

func (t *topicReadTool) ParameterSchema() string {
	return schema(map[string]any{
		"topic_id": prop("string", "The topic's id."),
		"cursor":   prop("string", "next_cursor from the previous page, to read older turns. Omit for the newest."),
		"limit":    prop("integer", fmt.Sprintf("At most this many turns, 1-%d. Default %d.", topicReadMax, topicReadDefault)),
	}, "topic_id")
}

type turnView struct {
	TaskID         string   `json:"task_id"`
	Time           string   `json:"time"`
	Status         string   `json:"status"`
	Message        string   `json:"message"`
	MessageCut     bool     `json:"message_truncated,omitempty"`
	Reply          string   `json:"reply,omitempty"`
	ReplyCut       bool     `json:"reply_truncated,omitempty"`
	Error          string   `json:"error,omitempty"`
	Files          []string `json:"files,omitempty"`
	ReferencedPath []string `json:"referenced_files,omitempty"`
}

func (t *topicReadTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if err := checkCall(ctx, t.Name(), t.deps); err != nil {
		return "", err
	}
	if err := rejectUnknown(params, "topic_id", "cursor", "limit"); err != nil {
		return "", err
	}
	store := t.deps.Topics
	if store == nil {
		return "", errNoStore
	}
	topicID := stringParam(params, "topic_id")
	if topicID == "" {
		return "", fmt.Errorf("topic_id is required")
	}
	topic, ok := store.GetTopic(topicID)
	if !ok || topic == nil || topic.DeletedAt != nil || topic.ID != topicID {
		return "", fmt.Errorf("no topic %s", topicID)
	}
	cursor := stringParam(params, "cursor")
	if cursor != "" {
		if _, ok := pagination.ParseKeysetCursor(cursor); !ok {
			return "", fmt.Errorf("invalid cursor; pass next_cursor from the previous page")
		}
	}
	limit := limitParam(params, topicReadDefault, topicReadMax)
	page := store.List(daemonruntime.TaskListOptions{TopicID: topicID, Limit: limit + 1, Cursor: cursor})
	more := len(page) > limit
	if more {
		page = page[:limit]
	}
	turns := make([]turnView, 0, len(page))
	for _, task := range page {
		if !ownerMayRead(task) {
			continue
		}
		turns = append(turns, viewTurn(task))
	}
	workspaceDir, source := t.deps.topicWorkspace(ctx, topic.ID)
	out := map[string]any{
		"topic": map[string]any{
			"id":               topic.ID,
			"title":            strings.TrimSpace(topic.Title),
			"kind":             topicKind(topic.ID),
			"tags":             capStrings(topic.Tags, readTagsPerTopic),
			"last_activity":    formatTime(topic.UpdatedAt),
			"workspace":        workspaceDir,
			"workspace_source": source,
		},
		"turns": turns,
	}
	if more && len(page) > 0 {
		last := page[len(page)-1]
		out["next_cursor"] = pagination.EncodeKeysetCursor(last.CreatedAt, last.ID)
	}
	return result(out)
}

func viewTurn(task daemonruntime.TaskInfo) turnView {
	message, reply := taskText(task)
	v := turnView{TaskID: task.ID, Time: formatTime(task.CreatedAt), Status: string(task.Status)}
	v.Message, v.MessageCut = cut(message, readMessageRunes)
	if reply != strings.TrimSpace(task.Error) {
		v.Reply, v.ReplyCut = cut(reply, readReplyRunes)
	}
	if errText := strings.TrimSpace(task.Error); errText != "" {
		v.Error, _ = cut(errText, readErrorRunes)
	}
	for _, file := range task.Attachments {
		if name := strings.TrimSpace(file.Name); name != "" && len(v.Files) < readFilesPerTask {
			v.Files = append(v.Files, name)
		}
	}
	for _, ref := range task.FileReferences {
		if name := strings.TrimSpace(ref.Path); name != "" && len(v.ReferencedPath) < readFilesPerTask {
			v.ReferencedPath = append(v.ReferencedPath, filepath.Base(filepath.FromSlash(name)))
		}
	}
	return v
}
