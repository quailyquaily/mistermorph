package topiccontext

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

// CountFunc asks the provider how many input tokens a request holds.
type CountFunc func(ctx context.Context, req llm.Request) (int, error)

// ErrNoStoredRequest means the snapshot's full request was not kept, so it can only be estimated.
var ErrNoStoredRequest = errors.New("the request was not kept for counting")

// CountSnapshot replaces the conversation snapshot's estimates with the provider's counts, and saves
// the result. It counts growing prefixes of the request (the system prompt without its skills
// section, the system prompt, then tools, history, the current message and this run's steps), so
// each part's size is the difference between two counts. Within a part, sections and messages are
// split by their estimates. The parts are then scaled to the billed input total, which the counts
// should match closely.
//
// A provider that cannot count marks the snapshot so it is not asked again; other errors leave the
// snapshot as it was.
func (s *Store) CountSnapshot(ctx context.Context, conversationKey string, count CountFunc) (Snapshot, error) {
	snapshot, ok, err := s.Snapshot(conversationKey)
	if err != nil || !ok {
		return snapshot, err
	}
	if snapshot.Method == MethodProvider || snapshot.CountUnsupported {
		return snapshot, nil
	}
	var stored storedRequest
	found, err := readStoredRequest(requestPath(s.snapshotPath(snapshot.ConversationKey)), &stored)
	if err != nil {
		return snapshot, err
	}
	if !found || stored.CapturedAt != snapshot.CapturedAt {
		return snapshot, ErrNoStoredRequest
	}
	groups, err := countGroups(ctx, stored, count)
	if errors.Is(err, llm.ErrTokenCountUnsupported) {
		snapshot.CountUnsupported = true
		_ = s.saveSnapshot(snapshot)
		return snapshot, err
	}
	if err != nil {
		return snapshot, err
	}
	applyCounts(&snapshot, groups)
	snapshot.Method = MethodProvider
	snapshot.CountedAt = time.Now().UTC().Format(time.RFC3339)
	return snapshot, s.saveSnapshot(snapshot)
}

func (s *Store) saveSnapshot(snapshot Snapshot) error {
	return writeSnapshot(s.snapshotPath(snapshot.ConversationKey), snapshot)
}

// countGroups returns each top-level part's provider-counted size, and the whole request's under
// the empty kind.
func countGroups(ctx context.Context, stored storedRequest, count CountFunc) (map[string]int64, error) {
	kindOf := func(i int) string {
		if i < len(stored.MessageKinds) && stored.MessageKinds[i] != "" {
			return stored.MessageKinds[i]
		}
		if i == 0 && stored.Messages[0].Role == "system" {
			return llm.MessageKindSystem
		}
		return llm.MessageKindHistory
	}
	// The groups, in the order their messages appear.
	stages := []struct {
		group string
		kinds []string
	}{
		{PartHistory, []string{llm.MessageKindSummary, llm.MessageKindHistory}},
		{PartCurrent, []string{llm.MessageKindMeta, llm.MessageKindCurrent}},
		{PartSteps, []string{llm.MessageKindStep}},
	}
	var system []llm.Message
	for i, message := range stored.Messages {
		if kindOf(i) == llm.MessageKindSystem {
			system = append(system, message)
		}
	}
	counter := func(messages []llm.Message, tools []llm.Tool) (int64, error) {
		if len(messages) == 0 && len(tools) == 0 {
			return 0, nil
		}
		n, err := count(ctx, llm.Request{Model: stored.Model, Messages: messages, Tools: tools})
		return int64(n), err
	}
	out := map[string]int64{}
	systemTotal, err := counter(system, nil)
	if err != nil {
		return nil, err
	}
	out[PartSystem] = systemTotal
	if len(system) > 0 {
		if stripped, removed := withoutSkillsSection(messageText(system[0])); removed {
			trimmed := append([]llm.Message(nil), system...)
			trimmed[0] = llm.Message{Role: system[0].Role, Content: stripped}
			withoutSkills, err := counter(trimmed, nil)
			if err != nil {
				return nil, err
			}
			out[PartSkills] = max(0, systemTotal-withoutSkills)
			out[PartSystem] = withoutSkills
		}
	}
	previous := systemTotal
	if len(stored.Tools) > 0 {
		withTools, err := counter(system, stored.Tools)
		if err != nil {
			return nil, err
		}
		out[PartTools] = max(0, withTools-previous)
		previous = withTools
	}
	prefix := append([]llm.Message(nil), system...)
	for _, stage := range stages {
		added := false
		for i, message := range stored.Messages {
			for _, kind := range stage.kinds {
				if kindOf(i) == kind {
					prefix = append(prefix, message)
					added = true
				}
			}
		}
		if !added {
			continue
		}
		total, err := counter(prefix, stored.Tools)
		if err != nil {
			return nil, err
		}
		out[stage.group] = max(0, total-previous)
		previous = total
	}
	out[""] = previous
	return out, nil
}

// applyCounts sets each top-level part to its counted share of the billed total, and splits it
// among its children in proportion to their current (estimated) tokens.
func applyCounts(snapshot *Snapshot, groups map[string]int64) {
	counted := groups[""]
	snapshot.CountedInputTokens = counted
	target := float64(snapshot.InputTokens)
	if target <= 0 {
		target = float64(counted)
	}
	scale := 1.0
	if counted > 0 {
		scale = target / float64(counted)
	}
	type leafTarget struct {
		part  *Part
		exact float64
	}
	var leaves []leafTarget
	var spread func(part *Part, exact float64)
	spread = func(part *Part, exact float64) {
		if len(part.Children) == 0 {
			leaves = append(leaves, leafTarget{part, exact})
			return
		}
		var weight int64
		for _, child := range part.Children {
			weight += child.Tokens
		}
		for i := range part.Children {
			share := 1 / float64(len(part.Children))
			if weight > 0 {
				share = float64(part.Children[i].Tokens) / float64(weight)
			}
			spread(&part.Children[i], exact*share)
		}
	}
	for i := range snapshot.Parts {
		spread(&snapshot.Parts[i], float64(groups[snapshot.Parts[i].Kind])*scale)
	}
	// Round the leaves so they add up to the rounded total.
	total := int64(math.Round(target))
	var assigned int64
	sort.SliceStable(leaves, func(i, j int) bool {
		return leaves[i].exact-math.Floor(leaves[i].exact) > leaves[j].exact-math.Floor(leaves[j].exact)
	})
	for _, leaf := range leaves {
		leaf.part.Tokens = int64(math.Floor(leaf.exact))
		assigned += leaf.part.Tokens
	}
	for i := 0; assigned < total && i < len(leaves); i++ {
		leaves[i].part.Tokens++
		assigned++
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
	sumUp(snapshot.Parts)
}

func readStoredRequest(path string, out *storedRequest) (bool, error) {
	ok, err := readJSONFile(path, out)
	if err != nil {
		return false, fmt.Errorf("read stored request: %w", err)
	}
	return ok, nil
}
