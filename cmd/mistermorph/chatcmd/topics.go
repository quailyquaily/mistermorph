package chatcmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/contextcheckpoint"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pagination"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

type localTopicsMsg struct {
	items         []taskdomain.TopicInfo
	scope, cursor string
	more          bool
}

type localHistoryMsg struct {
	topic  taskdomain.TopicInfo
	tasks  []taskdomain.TaskInfo
	cursor string
	more   bool
	status chatSessionStatus
}

type localDeleteConfirmMsg struct{ id string }

func (s *chatSession) topicsCommand(cursor string) (*chatcommands.Result, error) {
	if s.sharedTopics == nil {
		return nil, fmt.Errorf("topic store is unavailable")
	}
	var items []taskdomain.TopicInfo
	start := cursor
	for len(items) < 50 {
		batch := s.sharedTopics.ListTopicsPage(daemonruntime.TopicListOptions{Limit: 50, Cursor: cursor})
		if err := s.sharedTopics.ProjectionError(); err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			cursor = ""
			break
		}
		for _, topic := range batch {
			cursor = pagination.EncodeKeysetCursor(topic.UpdatedAt, topic.ID)
			resolved, err := workspace.Resolve(s.sharedWorkspaces, "console:"+topic.ID, s.defaultWorkspaceDir)
			if err != nil {
				return nil, err
			}
			if resolved.WorkspaceDir == s.workspaceDir {
				items = append(items, topic)
			}
			if len(items) == 50 {
				break
			}
		}
		if len(items) == 50 {
			break
		}
		if len(batch) < 50 {
			cursor = ""
			break
		}
	}
	if s.sendMsg != nil {
		s.sendMsg(localTopicsMsg{items: items, scope: s.workspaceDir, cursor: cursor, more: start != ""})
	}
	return &chatcommands.Result{}, nil
}

func (s *chatSession) localHistory(cursor string) (localHistoryMsg, error) {
	r := localHistoryMsg{more: cursor != "", status: chatSessionStatusFromSession(s)}
	if s.topicID == "" {
		return r, nil
	}
	topic, ok := s.sharedTopics.GetTopic(s.topicID)
	if !ok || topic.DeletedAt != nil {
		return r, fmt.Errorf("topic %q not found", s.topicID)
	}
	r.topic = *topic
	items := s.sharedTopics.List(daemonruntime.TaskListOptions{TopicID: s.topicID, Limit: 51, Cursor: cursor})
	if err := s.sharedTopics.ProjectionError(); err != nil {
		return r, err
	}
	page := pagination.PageFromLookahead(items, 50, func(t taskdomain.TaskInfo) string { return pagination.EncodeKeysetCursor(t.CreatedAt, t.ID) })
	r.tasks, r.cursor = page.Items, page.NextCursor
	return r, nil
}

func (s *chatSession) topicCommand(ctx context.Context, args string) (*chatcommands.Result, error) {
	if s.sharedTopics == nil {
		return nil, fmt.Errorf("topic store is unavailable")
	}
	action, rest, _ := strings.Cut(strings.TrimSpace(args), " ")
	rest = strings.TrimSpace(rest)
	switch action {
	case "new":
		if err := s.selectLocalTopic(""); err != nil {
			return nil, err
		}
	case "switch":
		if rest == "" {
			return nil, fmt.Errorf("usage: /topic switch <id>")
		}
		if err := s.selectLocalTopic(rest); err != nil {
			return nil, err
		}
	case "history":
		if s.topicID == "" {
			return &chatcommands.Result{Reply: "Send a message first to create a topic."}, nil
		}
	case "delete":
		if s.topicID == "" {
			return &chatcommands.Result{Reply: "Send a message first to create a topic."}, nil
		}
		if rest != "confirm "+s.topicID {
			if s.sendMsg != nil {
				s.sendMsg(localDeleteConfirmMsg{id: s.topicID})
			}
			return &chatcommands.Result{}, nil
		}
		if _, err := s.sharedTopics.DeleteTopic(s.topicID); err != nil {
			return nil, err
		}
		key := s.conversationKey()
		s.topicID = ""
		if _, _, err := s.sharedWorkspaces.Delete(key); err != nil {
			return nil, err
		}
		if err := contextcheckpoint.Reset(ctx, s.contextCheckpointRoot(), key); err != nil {
			return nil, err
		}
	case "title":
		if rest != "regenerate" {
			return nil, fmt.Errorf("usage: /topic title regenerate")
		}
		if err := s.regenerateLocalTopicTitle(ctx); err != nil {
			return nil, err
		}
	default:
		return &chatcommands.Result{Reply: "/topic new · switch <id> · history [more] · title regenerate · delete"}, nil
	}
	cursor := ""
	if action == "history" && strings.HasPrefix(rest, "more ") {
		cursor = strings.TrimSpace(strings.TrimPrefix(rest, "more "))
	}
	r, err := s.localHistory(cursor)
	if err != nil {
		return nil, err
	}
	if s.sendMsg != nil {
		s.sendMsg(r)
	}
	return &chatcommands.Result{}, nil
}
