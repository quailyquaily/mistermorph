package contextcheckpoint

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/llm"
)

type PreparedHistory struct {
	Store                  *FileStore
	History                []chathistory.ChatHistoryItem
	HistoryBoundaries      []string
	CurrentMessageBoundary string
}

func PrepareHistory(ctx context.Context, root string, conversationKey string, history []chathistory.ChatHistoryItem, current chathistory.ChatHistoryItem) (PreparedHistory, error) {
	store, err := NewFileStore(root, conversationKey)
	if err != nil {
		return PreparedHistory{}, err
	}
	checkpoint, found, err := store.Load(ctx)
	if err != nil {
		return PreparedHistory{}, fmt.Errorf("load context checkpoint: %w", err)
	}
	coveredThrough := ""
	if found {
		coveredThrough = checkpoint.CoveredThrough
	}
	if found && checkpointOutlived(history, coveredThrough) {
		// The history window has moved past everything the checkpoint summarizes, so those turns
		// would have dropped out of the prompt without compaction too. Keeping the checkpoint would
		// carry an old topic (and its unfinished work) into the conversation for good.
		if err := store.Delete(ctx, checkpoint.Revision); err != nil && !errors.Is(err, agent.ErrContextCheckpointRevisionConflict) {
			return PreparedHistory{}, fmt.Errorf("expire context checkpoint: %w", err)
		}
		coveredThrough = ""
	}
	filtered := chathistory.FilterAfterBoundary(history, coveredThrough)
	prepared := PreparedHistory{
		Store:                  store,
		History:                filtered,
		CurrentMessageBoundary: chathistory.BoundaryForItem(current),
	}
	for _, item := range filtered {
		prepared.HistoryBoundaries = append(prepared.HistoryBoundaries, chathistory.BoundaryForItem(item))
	}
	return prepared, nil
}

// checkpointOutlived reports whether the item a checkpoint covers through is no longer in the
// history window. A checkpoint without a boundary can't be placed, so it is kept.
func checkpointOutlived(history []chathistory.ChatHistoryItem, coveredThrough string) bool {
	coveredThrough = strings.TrimSpace(coveredThrough)
	if coveredThrough == "" {
		return false
	}
	for _, item := range history {
		if chathistory.BoundaryForItem(item) == coveredThrough {
			return false
		}
	}
	return true
}

func Reset(ctx context.Context, root string, conversationKey string) error {
	if strings.TrimSpace(conversationKey) == "" {
		return nil
	}
	// A reset also forgets the tools the conversation found through tool search.
	if err := ClearFoundTools(root, conversationKey); err != nil {
		return err
	}
	store, err := NewFileStore(root, conversationKey)
	if err != nil {
		return err
	}
	checkpoint, found, err := store.Load(ctx)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	return store.Delete(ctx, checkpoint.Revision)
}

func FilterMessageHistory(messages []llm.Message, boundaries []string, coveredThrough string) ([]llm.Message, []string) {
	start := 0
	coveredThrough = strings.TrimSpace(coveredThrough)
	if coveredThrough != "" {
		for index := len(messages) - 1; index >= 0; index-- {
			if index < len(boundaries) && strings.TrimSpace(boundaries[index]) == coveredThrough {
				start = index + 1
				break
			}
		}
	}
	filteredMessages := append([]llm.Message(nil), messages[start:]...)
	filteredBoundaries := make([]string, len(filteredMessages))
	for index := range filteredMessages {
		sourceIndex := start + index
		if sourceIndex < len(boundaries) {
			filteredBoundaries[index] = boundaries[sourceIndex]
		}
	}
	return filteredMessages, filteredBoundaries
}
