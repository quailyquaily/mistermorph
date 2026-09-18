package daemonruntime

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

var ErrTopicBusy = errors.New("topic is running in another chat or Console; wait for it to finish")

func activeConsoleTask(task TaskInfo) bool {
	return task.Status == TaskQueued || task.Status == TaskRunning || task.Status == TaskPending
}

// ChatOwnsTask protects in-process stop and approval handles from another
// executor. Shared history does not transfer ownership of a live task.
func (s *ConsoleFileStore) ChatOwnsTask(id string) (bool, error) {
	unlock, err := s.lockShared()
	if err != nil {
		return false, err
	}
	defer unlock()
	return s.triggers[id].Source == "chat" && activeConsoleTask(s.items[id]), nil
}

// lockShared serializes a read/modify/append operation across Console and chat
// processes. Refresh before reading so a local projection never skips another
// writer's events when advancing its journal cursor.
func (s *ConsoleFileStore) lockShared() (func(), error) {
	unlock, err := s.lockState()
	if err != nil {
		return nil, err
	}
	if s.persist {
		before := s.projectionCursor
		if err := s.replayJournalLocked(before); err != nil {
			s.projectionErr = err
			unlock()
			return nil, err
		}
		if before != s.projectionCursor {
			s.orderedIDs = rebuildOrderedTaskIDs(s.items)
			s.orderedIDsByTopic = groupOrderedTaskIDsByTopic(s.orderedIDs, s.items)
			s.orderedTopicIDs = rebuildOrderedTopicIDs(s.topics)
		}
		if err := s.recoverNonTerminalTasksLocked(time.Now().UTC(), true); err != nil {
			s.projectionErr = err
			unlock()
			return nil, err
		}
	}
	return unlock, nil
}

func (s *ConsoleFileStore) lockState() (func(), error) {
	s.mu.Lock()
	if !s.persist {
		return s.mu.Unlock, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	release, err := fsstore.AcquireLock(ctx, filepath.Join(s.rootDir, "state.lck"))
	if err != nil {
		s.projectionErr = err
		s.mu.Unlock()
		return nil, err
	}
	return func() {
		release()
		s.mu.Unlock()
	}, nil
}

// AcquireChatSession identifies live local executions during Console recovery.
// The release function must outlive every task and pending approval in chat.
func (s *ConsoleFileStore) AcquireChatSession(ctx context.Context) (string, func(), error) {
	id := uuid.NewString()
	path, err := fsstore.BuildLockPath(filepath.Join(s.rootDir, "sessions"), id)
	if err != nil {
		return "", nil, err
	}
	release, err := fsstore.AcquireLock(ctx, path)
	return id, release, err
}

func (s *ConsoleFileStore) chatSessionAlive(id string) (bool, error) {
	path, err := fsstore.BuildLockPath(filepath.Join(s.rootDir, "sessions"), id)
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	release, err := fsstore.AcquireLock(ctx, path)
	if errors.Is(err, fsstore.ErrLockTimeout) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	release()
	return false, nil
}
