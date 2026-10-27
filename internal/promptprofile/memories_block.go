package promptprofile

import (
	_ "embed"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/memories"
)

//go:embed prompts/block_memories.md
var memoriesBlockTemplateSource string

// MemoriesInlineBudget is how many bytes of memory bodies the block shows. Past it, only each
// memory's description is listed, and the model reads the rest with memory_search.
const MemoriesInlineBudget = 6 << 10

const memorySaveRules = `When to save, with memory_save:
- A correction or an approach someone confirmed: type feedback, with "Why:" and "How to apply:" lines.
- What a person tells you about themselves, their work or their goals: type person or context, with dates written as absolute dates.
- Anything you are asked to remember.
Do not save summaries of what was done or discussed (the journal keeps that), things that matter only in this task, or credentials and secrets. Update a memory that overlaps instead of adding another (save with its subject and name), and forget one that turned out wrong (memory_forget). Find memory_search and the journal tools with tool_search when they are not listed.`

// AppendMemoriesBlock tells the model who can hear it, how to keep memories, and the memories this
// audience may hear without searching. readOnly leaves out the saving rules.
func AppendMemoriesBlock(spec *agent.PromptSpec, who audience.Audience, items []memories.Memory, more bool, readOnly bool) {
	if spec == nil || who.IsZero() {
		return
	}
	rules := memorySaveRules
	if readOnly {
		rules = "This run reads memories but does not save or forget any."
	}
	content := strings.NewReplacer(
		"{{AUDIENCE}}", describeAudience(who),
		"{{SAVE_RULES}}", rules,
		"{{MEMORIES}}", renderMemories(items, more),
	).Replace(memoriesBlockTemplateSource)
	spec.Blocks = append(spec.Blocks, agent.PromptBlock{Content: strings.TrimSpace(content)})
}

func describeAudience(who audience.Audience) string {
	switch who.Kind {
	case audience.KindOwner:
		return "the owner, the person you work for. Save with subject owner for what is about them, general for how to work in general."
	case audience.KindContact:
		return fmt.Sprintf("one contact (%s) in a direct message. Save what they say about themselves with subject %s; a contact can only say how to work with them, not how you work in general.", who.ID, who.String())
	case audience.KindConversation:
		return fmt.Sprintf("everyone in a group conversation (%s). A group is a public square: speak as you would in public, and do not repeat what someone told you in private. Save what concerns the group with subject %s.", who.ID, who.String())
	}
	return ""
}

func renderMemories(items []memories.Memory, more bool) string {
	if len(items) == 0 {
		return "No memories here yet."
	}
	total := 0
	for _, m := range items {
		total += len(m.Body)
	}
	inline := total <= MemoriesInlineBudget
	var b strings.Builder
	if inline {
		b.WriteString("Memories you may use here:\n")
	} else {
		b.WriteString("Memories you may use here (descriptions only; read one with memory_search):\n")
	}
	for _, m := range items {
		updated := m.UpdatedAt
		if len(updated) >= 10 {
			updated = updated[:10]
		}
		fmt.Fprintf(&b, "- %s · %s · %s (%s, updated %s", m.ID, m.Subject, m.Name, m.Type, updated)
		if m.ToldBy != "" {
			fmt.Fprintf(&b, ", told by %s", m.ToldBy)
		}
		fmt.Fprintf(&b, "): %s\n", m.Description)
		if inline {
			for _, line := range strings.Split(m.Body, "\n") {
				b.WriteString("  " + line + "\n")
			}
		}
	}
	if more {
		b.WriteString("More memories exist than are listed; use memory_search to find them.\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
