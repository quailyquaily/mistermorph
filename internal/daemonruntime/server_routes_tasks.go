package daemonruntime

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/pagination"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/internal/topicstate"
)

func (routes *routeRegistration) registerTaskRoutes() {
	mux := routes.mux
	opts := routes.options.TaskTopic
	authToken := routes.authToken
	reader := opts.TaskReader
	topicReader := opts.TopicReader
	topicDeleter := opts.TopicDeleter
	createTopic := opts.CreateTopic
	submit := opts.Submit
	stop := opts.Stop

	mux.HandleFunc("/tasks", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if reader == nil {
				http.Error(w, "task reader is unavailable", http.StatusServiceUnavailable)
				return
			}
			rawStatus := strings.TrimSpace(r.URL.Query().Get("status"))
			status, ok := taskdomain.ParseTaskStatus(rawStatus)
			if !ok {
				http.Error(w, "invalid status", http.StatusBadRequest)
				return
			}
			limit := taskListDefaultLimit
			if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
				parsed, err := strconv.Atoi(rawLimit)
				if err != nil || parsed <= 0 {
					http.Error(w, "invalid limit", http.StatusBadRequest)
					return
				}
				if parsed > taskListMaxLimit {
					http.Error(w, "invalid limit", http.StatusBadRequest)
					return
				}
				limit = parsed
			}
			cursorRaw := strings.TrimSpace(r.URL.Query().Get("cursor"))
			if _, ok := pagination.ParseKeysetCursor(cursorRaw); !ok {
				http.Error(w, "invalid cursor", http.StatusBadRequest)
				return
			}
			items := reader.List(TaskListOptions{
				Status:  status,
				Limit:   limit + 1,
				TopicID: strings.TrimSpace(r.URL.Query().Get("topic_id")),
				Cursor:  cursorRaw,
			})
			page := pagination.PageFromLookahead(items, limit, func(item TaskInfo) string {
				return pagination.EncodeKeysetCursor(item.CreatedAt, item.ID)
			})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(page)
			return

		case http.MethodPost:
			if submit == nil {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			var req SubmitTaskRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			req.Task = strings.TrimSpace(req.Task)
			if req.Task == "" {
				http.Error(w, "missing task", http.StatusBadRequest)
				return
			}
			resp, err := submit(r.Context(), req)
			if err != nil {
				if msg, ok := badRequestMessage(err); ok {
					http.Error(w, msg, http.StatusBadRequest)
					return
				}
				http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			return

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	})

	mux.HandleFunc("/topics", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if topicReader == nil {
				http.Error(w, "topic reader is unavailable", http.StatusServiceUnavailable)
				return
			}
			limit := topicListDefaultLimit
			if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
				parsed, err := strconv.Atoi(rawLimit)
				if err != nil || parsed <= 0 || parsed > topicListMaxLimit {
					http.Error(w, "invalid limit", http.StatusBadRequest)
					return
				}
				limit = parsed
			}
			cursorRaw := strings.TrimSpace(r.URL.Query().Get("cursor"))
			if _, ok := pagination.ParseKeysetCursor(cursorRaw); !ok {
				http.Error(w, "invalid cursor", http.StatusBadRequest)
				return
			}
			items := topicReader.ListTopicsPage(TopicListOptions{Limit: limit + 1, Cursor: cursorRaw})
			page := pagination.PageFromLookahead(items, limit, func(item TopicInfo) string {
				return pagination.EncodeKeysetCursor(item.UpdatedAt, item.ID)
			})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(page)
			return
		case http.MethodPost:
			if createTopic == nil {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			var req CreateTopicRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			topic, err := createTopic(strings.TrimSpace(req.Title))
			if err != nil {
				if msg, ok := badRequestMessage(err); ok {
					http.Error(w, msg, http.StatusBadRequest)
					return
				}
				http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(topic)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	})

	mux.HandleFunc("/tasks/", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		suffix := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/tasks/"))
		if suffix == "" {
			http.Error(w, "missing task_id", http.StatusBadRequest)
			return
		}
		if strings.HasSuffix(suffix, "/stop") {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if stop == nil {
				http.Error(w, "stop is unavailable", http.StatusServiceUnavailable)
				return
			}
			taskID := strings.TrimSpace(strings.TrimSuffix(suffix, "/stop"))
			if taskID == "" || strings.Contains(taskID, "/") {
				http.Error(w, "missing task_id", http.StatusBadRequest)
				return
			}
			resp, err := stop(r.Context(), StopTaskRequest{
				TaskID: taskID,
				Reason: "/stop",
			})
			if err != nil {
				if msg, ok := badRequestMessage(err); ok {
					http.Error(w, msg, http.StatusBadRequest)
					return
				}
				http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if reader == nil {
			http.Error(w, "task reader is unavailable", http.StatusServiceUnavailable)
			return
		}
		if strings.Contains(suffix, "/") {
			http.NotFound(w, r)
			return
		}
		info, ok := reader.Get(suffix)
		if !ok || info == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	})

	// The tag view's arrangement: the order of the tag groups and of the topics within them.
	mux.HandleFunc("/topics/layout", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if opts.TopicLayout == nil || opts.SetTopicLayout == nil {
			http.NotFound(w, r)
			return
		}
		var (
			layout topicstate.Layout
			err    error
		)
		switch r.Method {
		case http.MethodGet:
			layout, err = opts.TopicLayout()
		case http.MethodPut:
			var req topicstate.Layout
			if decodeErr := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); decodeErr != nil {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			layout, err = opts.SetTopicLayout(req)
		default:
			w.Header().Set("Allow", "GET, PUT")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err != nil {
			http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(layout)
	})

	mux.HandleFunc("/topics/", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		suffix := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/topics/"))
		if suffix == "" {
			http.Error(w, "missing topic_id", http.StatusBadRequest)
			return
		}
		if strings.HasSuffix(suffix, "/regenerate-title") {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(suffix, "/regenerate-title")
			if id == "" || strings.Contains(id, "/") || id == ConsoleDefaultTopicID || id == ConsoleAwarenessTopicID {
				http.Error(w, "topic cannot be renamed", http.StatusBadRequest)
				return
			}
			if opts.RegenerateTopicTitle == nil || topicReader == nil {
				http.Error(w, "topic name generation is unavailable", http.StatusServiceUnavailable)
				return
			}
			topic, ok := topicReader.GetTopic(id)
			if !ok || topic == nil || topicDeleted(*topic) {
				http.NotFound(w, r)
				return
			}
			updated, err := opts.RegenerateTopicTitle(r.Context(), id)
			if err != nil {
				status := http.StatusServiceUnavailable
				if errors.Is(err, ErrTopicTitleChanged) || errors.Is(err, ErrTopicTitleBusy) {
					status = http.StatusConflict
				} else if _, ok := badRequestMessage(err); ok {
					status = http.StatusBadRequest
				}
				http.Error(w, err.Error(), status)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(updated)
			return
		}
		if strings.HasSuffix(suffix, "/tags") {
			if r.Method != http.MethodPut {
				w.Header().Set("Allow", "PUT")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(suffix, "/tags")
			if id == "" || strings.Contains(id, "/") {
				http.Error(w, "missing topic_id", http.StatusBadRequest)
				return
			}
			if opts.SetTopicTags == nil {
				http.Error(w, "topic tags are unavailable", http.StatusServiceUnavailable)
				return
			}
			var req struct {
				Tags []string `json:"tags"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			tagged, err := opts.SetTopicTags(id, req.Tags)
			if err != nil {
				if errors.Is(err, ErrTopicNotFound) {
					http.NotFound(w, r)
					return
				}
				if msg, ok := badRequestMessage(err); ok {
					http.Error(w, msg, http.StatusBadRequest)
					return
				}
				http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(tagged)
			return
		}
		if strings.HasSuffix(suffix, "/stop") {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if stop == nil {
				http.Error(w, "stop is unavailable", http.StatusServiceUnavailable)
				return
			}
			topicID := strings.TrimSpace(strings.TrimSuffix(suffix, "/stop"))
			if topicID == "" || strings.Contains(topicID, "/") {
				http.Error(w, "missing topic_id", http.StatusBadRequest)
				return
			}
			resp, err := stop(r.Context(), StopTaskRequest{
				TopicID: topicID,
				Reason:  "/stop",
			})
			if err != nil {
				if msg, ok := badRequestMessage(err); ok {
					http.Error(w, msg, http.StatusBadRequest)
					return
				}
				http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		id := suffix
		if strings.Contains(id, "/") {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if topicReader == nil {
				http.Error(w, "topic reader is unavailable", http.StatusServiceUnavailable)
				return
			}
			topic, ok := topicReader.GetTopic(id)
			if !ok || topic == nil || topicDeleted(*topic) {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(topic)
			return
		case http.MethodDelete:
			if topicDeleter == nil {
				http.Error(w, "topic delete is unavailable", http.StatusServiceUnavailable)
				return
			}
			deleted, err := topicDeleter.DeleteTopic(id)
			if err != nil {
				http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
				return
			}
			if !deleted {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
