package topiccontext

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/topicstate"
	"github.com/quailyquaily/mistermorph/llm"
)

// Snapshot is what a topic's last main request held, split into parts with a token count each, for
// the context window inspector. Only the latest request of each conversation is kept.
//
// Providers report only the request's total input, so each part is first estimated locally from
// its text, then all are scaled so they add up to the reported total. Method says how the parts
// were counted.
type Snapshot struct {
	ConversationKey          string `json:"conversation_key"`
	TopicID                  string `json:"topic_id,omitempty"`
	RunID                    string `json:"run_id,omitempty"`
	Model                    string `json:"model,omitempty"`
	CapturedAt               string `json:"captured_at"`
	ContextWindowTokens      int64  `json:"context_window_tokens,omitempty"`
	InputTokens              int64  `json:"input_tokens"`
	CachedInputTokens        int64  `json:"cached_input_tokens,omitempty"`
	CacheCreationInputTokens int64  `json:"cache_creation_input_tokens,omitempty"`
	Method                   string `json:"method"`
	// CountedInputTokens is the provider's count of the whole request, once counted.
	CountedInputTokens int64  `json:"counted_input_tokens,omitempty"`
	CountedAt          string `json:"counted_at,omitempty"`
	// CountUnsupported records that the provider could not count this request, so it is not asked again.
	CountUnsupported bool   `json:"count_unsupported,omitempty"`
	Parts            []Part `json:"parts"`
}

// Part is one piece of the request. Top-level parts have a Kind (system, skills, tools, history,
// current, steps); their children are the sections, tools or messages within.
type Part struct {
	Kind      string `json:"kind"`
	Label     string `json:"label,omitempty"`
	Role      string `json:"role,omitempty"`
	Tool      string `json:"tool,omitempty"`
	Tokens    int64  `json:"tokens"`
	Chars     int    `json:"chars"`
	Images    int    `json:"images,omitempty"`
	Content   string `json:"content,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// CacheBreakpoint marks a part the request tagged for prompt caching: the cached prefix ends
	// with it. CacheTTL is the tag's lifetime, when it names one.
	CacheBreakpoint bool   `json:"cache_breakpoint,omitempty"`
	CacheTTL        string `json:"cache_ttl,omitempty"`
	Children        []Part `json:"children,omitempty"`

	estimate float64
}

// Part kinds and the method of counting.
const (
	PartSystem  = "system"
	PartSkills  = "skills"
	PartTools   = "tools"
	PartHistory = "history"
	PartCurrent = "current"
	PartSteps   = "steps"

	PartSection = "section"
	PartTool    = "tool"
	PartMessage = "message"
	PartSummary = "summary"
	PartMeta    = "meta"

	MethodEstimate = "estimate"
	MethodProvider = "provider"
)

const (
	snapshotContentLimit = 16 << 10
	messageOverhead      = 4
	toolOverhead         = 8
	// imageEstimate is a rough cost of one image; providers size images differently.
	imageEstimate = 1000
)

// ObserveRequest records the request's snapshot for the conversation in ctx, alongside
// ObserveUsage. Only main-loop requests of a known conversation are kept.
func (s *Store) ObserveRequest(ctx context.Context, request llm.Request, sample UsageSample) {
	scope, ok := ScopeFromContext(ctx)
	if !ok || s == nil || s.stateDir == "" || !shouldTrackScene(sample.Scene) || sample.InputTokens <= 0 {
		return
	}
	layout, _ := llm.RequestLayoutFromContext(ctx)
	snapshot := BuildSnapshot(request, layout, sample)
	snapshot.ConversationKey = normalizeConversationKey(scope.ConversationKey)
	snapshot.TopicID = strings.TrimSpace(scope.TopicID)
	snapshot.ContextWindowTokens = itemFromSample(scope, sample).ContextWindowTokens
	options := fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600}
	path := s.snapshotPath(snapshot.ConversationKey)
	// The full request is kept beside the snapshot so the provider can count its parts later. A
	// request too large to keep (many images) is counted by estimate only.
	stored := storedRequest{CapturedAt: snapshot.CapturedAt, Model: request.Model, Messages: request.Messages, Tools: request.Tools, MessageKinds: layout.MessageKinds}
	if raw, err := json.Marshal(stored); err == nil && len(raw) <= storedRequestLimit {
		_ = fsstore.WriteTextAtomic(requestPath(path), string(raw), options)
	} else {
		_ = os.Remove(requestPath(path))
	}
	_ = writeSnapshot(path, snapshot)
}

func writeSnapshot(path string, snapshot Snapshot) error {
	return fsstore.WriteJSONAtomic(path, snapshot, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
}

func readJSONFile(path string, out any) (bool, error) {
	return fsstore.ReadJSON(path, out)
}

// storedRequest is a snapshot's full request, for counting by the provider.
type storedRequest struct {
	CapturedAt   string        `json:"captured_at"`
	Model        string        `json:"model,omitempty"`
	Messages     []llm.Message `json:"messages"`
	Tools        []llm.Tool    `json:"tools,omitempty"`
	MessageKinds []string      `json:"message_kinds,omitempty"`
}

const storedRequestLimit = 8 << 20

// requestPath is the full request kept beside a snapshot, in the same topic folder.
func requestPath(snapshotPath string) string {
	return filepath.Join(filepath.Dir(snapshotPath), "context_request.json")
}

// Snapshot returns the conversation's latest request snapshot.
func (s *Store) Snapshot(conversationKey string) (Snapshot, bool, error) {
	conversationKey = normalizeConversationKey(conversationKey)
	if s == nil || s.stateDir == "" || conversationKey == "" {
		return Snapshot{}, false, nil
	}
	var snapshot Snapshot
	ok, err := fsstore.ReadJSON(s.snapshotPath(conversationKey), &snapshot)
	if err != nil || !ok {
		return Snapshot{}, false, err
	}
	return snapshot, true, nil
}

// DeleteSnapshot removes the conversation's snapshot, which holds its prompts and messages.
func (s *Store) DeleteSnapshot(conversationKey string) error {
	conversationKey = normalizeConversationKey(conversationKey)
	if s == nil || s.stateDir == "" || conversationKey == "" {
		return nil
	}
	path := s.snapshotPath(conversationKey)
	for _, file := range []string{path, requestPath(path)} {
		if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	// The topic folder goes too once nothing else is in it.
	topicstate.RemoveIfEmpty(s.stateDir, conversationKey)
	return nil
}

// TopicDir is the folder under file_state_dir/topics that holds a conversation's topic state.
func (s *Store) TopicDir(conversationKey string) string {
	return topicstate.Dir(s.stateDir, normalizeConversationKey(conversationKey))
}

func (s *Store) snapshotPath(conversationKey string) string {
	return filepath.Join(s.TopicDir(conversationKey), "context_snapshot.json")
}

// BuildSnapshot splits a request into parts and counts them. layout tags the messages; a request
// without one is read as a system prompt followed by history.
func BuildSnapshot(request llm.Request, layout llm.RequestLayout, sample UsageSample) Snapshot {
	snapshot := Snapshot{
		RunID:                    strings.TrimSpace(sample.RunID),
		Model:                    strings.TrimSpace(sample.Model),
		InputTokens:              sample.InputTokens,
		CachedInputTokens:        sample.CachedInputTokens,
		CacheCreationInputTokens: sample.CacheCreationInputTokens,
		Method:                   MethodEstimate,
	}
	captured := sample.UpdatedAt
	if captured.IsZero() {
		captured = time.Now()
	}
	snapshot.CapturedAt = captured.UTC().Format(time.RFC3339)

	groups := map[string]*Part{}
	order := []string{PartSystem, PartSkills, PartTools, PartHistory, PartCurrent, PartSteps}
	for _, kind := range order {
		groups[kind] = &Part{Kind: kind}
	}
	toolNames := map[string]string{}
	for i, message := range request.Messages {
		kind := llm.MessageKindHistory
		if i < len(layout.MessageKinds) && layout.MessageKinds[i] != "" {
			kind = layout.MessageKinds[i]
		} else if i == 0 && strings.EqualFold(strings.TrimSpace(message.Role), "system") {
			kind = llm.MessageKindSystem
		}
		for _, call := range message.ToolCalls {
			if call.ID != "" {
				toolNames[call.ID] = call.Name
			}
		}
		switch kind {
		case llm.MessageKindSystem:
			sections, skills := systemPromptParts(messageText(message), messageCacheControl(message))
			groups[PartSystem].Children = append(groups[PartSystem].Children, sections...)
			groups[PartSkills].Children = append(groups[PartSkills].Children, skills...)
		case llm.MessageKindSummary:
			groups[PartHistory].Children = append(groups[PartHistory].Children, messagePart(PartSummary, message, toolNames))
		case llm.MessageKindMeta:
			groups[PartCurrent].Children = append(groups[PartCurrent].Children, messagePart(PartMeta, message, toolNames))
		case llm.MessageKindCurrent:
			groups[PartCurrent].Children = append(groups[PartCurrent].Children, messagePart(PartMessage, message, toolNames))
		case llm.MessageKindStep:
			groups[PartSteps].Children = append(groups[PartSteps].Children, messagePart(PartMessage, message, toolNames))
		default:
			groups[PartHistory].Children = append(groups[PartHistory].Children, messagePart(PartMessage, message, toolNames))
		}
	}
	for _, tool := range request.Tools {
		text := strings.TrimSpace(tool.Name + "\n" + tool.Description + "\n" + tool.ParametersJSON)
		part := textPart(PartTool, tool.Name, text)
		part.Tool = tool.Name
		part.estimate += toolOverhead
		markCache(&part, tool.CacheControl)
		groups[PartTools].Children = append(groups[PartTools].Children, part)
	}
	for _, kind := range order {
		group := groups[kind]
		if len(group.Children) == 0 {
			continue
		}
		for _, child := range group.Children {
			group.estimate += child.estimate
			group.Chars += child.Chars
			group.Images += child.Images
		}
		snapshot.Parts = append(snapshot.Parts, *group)
	}
	scaleParts(snapshot.Parts, sample.InputTokens)
	return snapshot
}

var (
	sectionHeading = regexp.MustCompile(`^##\s+(.+?)\s*$`)
	blockHeading   = regexp.MustCompile(`^\[\[\s*(.+?)\s*\]\]\s*$`)
)

// systemPromptParts splits the system prompt at its "## " headings, outside code fences. The
// "Available Skills" section is returned apart, and policy blocks, which open with a "[[ Title ]]"
// line, become sections of their own.
//
// A cache tag on the prompt marks the end of its text, so it goes on whichever section comes last.
func systemPromptParts(prompt string, cache *llm.CacheControl) (sections []Part, skills []Part) {
	chunks := splitSystemPrompt(prompt)
	for i, c := range chunks {
		part := textPart(PartSection, c.title, c.text)
		if i == len(chunks)-1 {
			markCache(&part, cache)
		}
		if isSkillsSection(c.title) {
			skills = append(skills, part)
		} else {
			sections = append(sections, part)
		}
	}
	if len(sections) > 0 {
		sections[0].estimate += messageOverhead
	}
	return sections, skills
}

// promptSection is one section of the system prompt: its heading and full text.
type promptSection struct {
	title string
	text  string
}

func isSkillsSection(title string) bool {
	return strings.EqualFold(strings.TrimSpace(title), "Available Skills")
}

// splitSystemPrompt splits the prompt at "## " headings and "[[ Title ]]" block openings, outside
// code fences. A heading with nothing under it before the next one (like the policies heading
// before its blocks) is kept with the section that follows.
func splitSystemPrompt(prompt string) []promptSection {
	type chunk struct {
		title string
		lines []string
	}
	var chunks []chunk
	current := chunk{}
	fenced := false
	for _, line := range strings.Split(prompt, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			fenced = !fenced
		}
		if !fenced {
			if m := sectionHeading.FindStringSubmatch(line); m != nil {
				chunks = append(chunks, current)
				current = chunk{title: m[1]}
			} else if m := blockHeading.FindStringSubmatch(trimmed); m != nil {
				chunks = append(chunks, current)
				current = chunk{title: m[1]}
			}
		}
		current.lines = append(current.lines, line)
	}
	chunks = append(chunks, current)
	var out []promptSection
	pending := ""
	for _, c := range chunks {
		text := strings.TrimSpace(strings.Join(c.lines, "\n"))
		if text == "" {
			continue
		}
		if c.title != "" && text == "## "+c.title {
			pending += text + "\n\n"
			continue
		}
		out = append(out, promptSection{title: c.title, text: pending + text})
		pending = ""
	}
	return out
}

// withoutSkillsSection is the system prompt with its skills section left out.
func withoutSkillsSection(prompt string) (string, bool) {
	var kept []string
	removed := false
	for _, section := range splitSystemPrompt(prompt) {
		if isSkillsSection(section.title) {
			removed = true
			continue
		}
		kept = append(kept, section.text)
	}
	return strings.Join(kept, "\n\n"), removed
}

func messagePart(kind string, message llm.Message, toolNames map[string]string) Part {
	text := messageText(message)
	var calls []string
	for _, call := range message.ToolCalls {
		raw := call.RawArguments
		if raw == "" && call.Arguments != nil {
			if encoded, err := json.Marshal(call.Arguments); err == nil {
				raw = string(encoded)
			}
		}
		calls = append(calls, call.Name+" "+raw)
	}
	if len(calls) > 0 {
		text = strings.TrimSpace(text + "\n" + strings.Join(calls, "\n"))
	}
	part := textPart(kind, "", text)
	part.Role = strings.ToLower(strings.TrimSpace(message.Role))
	if part.Role == "tool" {
		part.Tool = toolNames[message.ToolCallID]
	} else if len(message.ToolCalls) > 0 {
		names := make([]string, 0, len(message.ToolCalls))
		for _, call := range message.ToolCalls {
			names = append(names, call.Name)
		}
		part.Tool = strings.Join(names, ", ")
	}
	for _, p := range message.Parts {
		if p.Type == llm.PartTypeImageBase64 || p.Type == llm.PartTypeImageURL {
			part.Images++
		}
	}
	part.estimate += messageOverhead + float64(part.Images*imageEstimate)
	markCache(&part, messageCacheControl(message))
	return part
}

// messageCacheControl is the cache tag on any of the message's parts.
func messageCacheControl(message llm.Message) *llm.CacheControl {
	for i := len(message.Parts) - 1; i >= 0; i-- {
		if message.Parts[i].CacheControl != nil {
			return message.Parts[i].CacheControl
		}
	}
	return nil
}

func markCache(part *Part, cache *llm.CacheControl) {
	if cache == nil {
		return
	}
	part.CacheBreakpoint = true
	part.CacheTTL = strings.TrimSpace(cache.TTL)
}

// messageText is the message's text: its content, or its text parts.
func messageText(message llm.Message) string {
	if strings.TrimSpace(message.Content) != "" {
		return message.Content
	}
	var parts []string
	for _, p := range message.Parts {
		if p.Type == llm.PartTypeText && strings.TrimSpace(p.Text) != "" {
			parts = append(parts, p.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func textPart(kind, label, text string) Part {
	part := Part{Kind: kind, Label: strings.TrimSpace(label), Chars: utf8.RuneCountInString(text), estimate: EstimateTokens(text)}
	part.Content = text
	if len(part.Content) > snapshotContentLimit {
		cut := snapshotContentLimit
		for cut > 0 && !utf8.RuneStart(part.Content[cut]) {
			cut--
		}
		part.Content = part.Content[:cut]
		part.Truncated = true
	}
	return part
}

// EstimateTokens guesses the token count of text: about 3.6 ASCII characters per token, and one
// token per character of other scripts (CJK and the like, which tokenizers split finely).
func EstimateTokens(text string) float64 {
	ascii, other := 0, 0
	for _, r := range text {
		if r < utf8.RuneSelf {
			ascii++
		} else {
			other++
		}
	}
	return float64(ascii)/3.6 + float64(other)
}

// scaleParts sets every part's Tokens so the leaves add up to total, in proportion to their
// estimates (largest remainder), and each parent is the sum of its children. With no total the
// rounded estimates are kept.
func scaleParts(parts []Part, total int64) {
	var leaves []*Part
	var collect func(items []Part)
	collect = func(items []Part) {
		for i := range items {
			if len(items[i].Children) > 0 {
				collect(items[i].Children)
			} else {
				leaves = append(leaves, &items[i])
			}
		}
	}
	collect(parts)
	sum := 0.0
	for _, leaf := range leaves {
		sum += leaf.estimate
	}
	if total > 0 && sum > 0 {
		type rem struct {
			leaf *Part
			frac float64
		}
		rems := make([]rem, 0, len(leaves))
		assigned := int64(0)
		for _, leaf := range leaves {
			exact := leaf.estimate / sum * float64(total)
			leaf.Tokens = int64(math.Floor(exact))
			assigned += leaf.Tokens
			rems = append(rems, rem{leaf, exact - math.Floor(exact)})
		}
		sort.SliceStable(rems, func(i, j int) bool { return rems[i].frac > rems[j].frac })
		for i := 0; assigned < total && i < len(rems); i++ {
			rems[i].leaf.Tokens++
			assigned++
		}
	} else {
		for _, leaf := range leaves {
			leaf.Tokens = int64(math.Round(leaf.estimate))
		}
	}
	var sumUp func(items []Part) int64
	sumUp = func(items []Part) int64 {
		var n int64
		for i := range items {
			if len(items[i].Children) > 0 {
				items[i].Tokens = sumUp(items[i].Children)
			}
			n += items[i].Tokens
		}
		return n
	}
	sumUp(parts)
}
