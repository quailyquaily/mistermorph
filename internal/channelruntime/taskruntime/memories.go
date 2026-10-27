package taskruntime

import (
	"context"
	"log/slog"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/memories"
	"github.com/quailyquaily/mistermorph/internal/memorytools"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	// MemoryReminderAfter is how many turns of a direct conversation (the owner's or a contact's)
	// go by without a save before the agent is reminded to save; MemoryReminderAfterGroup is the
	// same for a group, where most messages are not meant for the agent to keep. Both are first
	// guesses, to tune from the memory_reminder logs.
	MemoryReminderAfter      = 8
	MemoryReminderAfterGroup = 20
)

// AttachMemories opens the memories of a run whose audience is who and registers the memory and
// journal tools for that audience. It returns nil, and registers nothing, when memories are off or
// the run has no audience, or when memory.db cannot be opened: memories are not worth failing a
// task over. The caller closes the store when the run ends.
func AttachMemories(ctx context.Context, paths runtimepaths.Paths, cfg toolsutil.MemoriesConfig, reg *tools.Registry, who audience.Audience, readOnly bool) (*memories.Store, error) {
	if !cfg.Enabled || who.IsZero() || reg == nil || strings.TrimSpace(paths.MemoryDBPath) == "" {
		return nil, nil
	}
	store, err := memories.Open(ctx, paths.MemoryDBPath)
	if err != nil {
		slog.Default().Warn("memories_unavailable", "error", err.Error())
		return nil, nil
	}
	for _, tool := range memorytools.New(memorytools.Deps{Store: store, JournalDir: paths.JournalDir, Audience: who, ReadOnly: readOnly}) {
		if err := reg.Replace(tool); err != nil {
			_ = store.Close()
			return nil, err
		}
	}
	return store, nil
}

// AppendMemoriesPrompt adds the memories block for who: the rules and the memories it may hear
// without searching. It does nothing without a store.
func AppendMemoriesPrompt(ctx context.Context, store *memories.Store, spec *agent.PromptSpec, who audience.Audience, readOnly bool, logger *slog.Logger) {
	if store == nil || spec == nil {
		return
	}
	items, more, err := store.ForPrompt(ctx, who, promptParticipants(who), memories.MaxPerSubject)
	if err != nil && logger != nil {
		logger.Warn("memories_prompt_error", "audience", who.String(), "error", err.Error())
	}
	promptprofile.AppendMemoriesBlock(spec, who, items, more, readOnly)
}

const memoryReminderText = "[[ Runtime Note ]]\nNothing has been saved to memory for several turns in this conversation. If in recent messages the person corrected you, confirmed an approach, or told you something lasting about themselves or their work, save it with memory_save during this task. If not, ignore this note."

func memoryReminderThreshold(who audience.Audience) int {
	if who.Kind == audience.KindConversation {
		return MemoryReminderAfterGroup
	}
	return MemoryReminderAfter
}

// promptParticipants are the contacts in a conversation whose public memories the prompt shows:
// the speaker the runtime resolved.
func promptParticipants(who audience.Audience) []string {
	if who.Kind == audience.KindConversation && who.Speaker != "" {
		return []string{who.Speaker}
	}
	return nil
}

// memoryReminderHook appends the reminder to the run's current message when the audience has gone
// the threshold of turns without a save. It acts only on the first step of a fresh run, so a
// resumed run neither shows nor uses up a reminder; the note goes into the user message rather
// than the system prompt, so the prompt cache is not disturbed.
func memoryReminderHook(store *memories.Store, who audience.Audience, logger *slog.Logger) agent.Hook {
	return func(ctx context.Context, step int, _ *agent.Context, messages *[]llm.Message) error {
		if step != 0 || messages == nil || len(*messages) == 0 {
			return nil
		}
		last := &(*messages)[len(*messages)-1]
		if last.Role != "user" {
			return nil
		}
		turns, due, err := store.TakeReminder(ctx, who, memoryReminderThreshold(who))
		if err != nil {
			logger.Warn("memory_reminder_error", "audience", who.String(), "error", err.Error())
			return nil
		}
		if !due {
			return nil
		}
		if len(last.Parts) > 0 {
			last.Parts = append(last.Parts, llm.Part{Type: llm.PartTypeText, Text: memoryReminderText})
		} else {
			last.Content = last.Content + "\n\n" + memoryReminderText
		}
		logger.Info("memory_reminder", "audience", who.String(), "turns_since_save", turns)
		return nil
	}
}

// countMemoryTurn counts a finished run toward the reminder. Runs that failed, only reacted, or
// cannot save are not turns anyone expects the agent to remember.
func (p preparedRuntimeRun) countMemoryTurn(final *agent.Final, err error) {
	if p.memories == nil || p.memoriesReadOnly || p.audience.IsZero() || err != nil || final == nil || final.IsLightweight {
		return
	}
	if _, countErr := p.memories.CountTurn(context.Background(), p.audience); countErr != nil && p.logger != nil {
		p.logger.Warn("memory_turn_count_error", "audience", p.audience.String(), "error", countErr.Error())
	}
}
