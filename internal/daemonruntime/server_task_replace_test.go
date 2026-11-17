package daemonruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func replaceRequest(t *testing.T, mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// POST /tasks/{id}/replace: a runtime without Replace answers 404, so a Console never has an edit
// taken for a new message by a runtime that does not know edits.
func TestTaskReplaceRouteIsMissingWithoutReplace(t *testing.T) {
	mux := http.NewServeMux()
	submitted := false
	RegisterRoutes(mux, RoutesOptions{AuthToken: "token", TaskTopic: TaskTopicRoutes{
		Submit: func(context.Context, SubmitTaskRequest) (SubmitTaskResponse, error) {
			submitted = true
			return SubmitTaskResponse{ID: "x"}, nil
		},
	}})
	rec := replaceRequest(t, mux, http.MethodPost, "/tasks/t1/replace", `{"task":"edited","topic_id":"topic-1"}`)
	if rec.Code != http.StatusNotFound || submitted {
		t.Fatalf("status = %d, submitted = %v; want 404 and nothing submitted", rec.Code, submitted)
	}
}

func TestTaskReplaceRoute(t *testing.T) {
	var got ReplaceTaskRequest
	var replaceErr error
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{AuthToken: "token", TaskTopic: TaskTopicRoutes{
		Replace: func(_ context.Context, req ReplaceTaskRequest) (ReplaceTaskResponse, error) {
			got = req
			if replaceErr != nil {
				return ReplaceTaskResponse{}, replaceErr
			}
			return ReplaceTaskResponse{ID: "n1", Status: TaskQueued, TopicID: req.TopicID, ReplacedTaskID: req.TaskID, RemovedTaskIDs: []string{"t2", req.TaskID}}, nil
		},
	}})

	rec := replaceRequest(t, mux, http.MethodPost, "/tasks/t1/replace", `{"task":"  edited  ","topic_id":" topic-1 ","llm_profile":"cheap","trigger":{"source":"ui","event":"chat_edit"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	if got.TaskID != "t1" || got.Task != "edited" || got.TopicID != "topic-1" || got.LLMProfile != "cheap" || got.Trigger == nil || got.Trigger.Event != "chat_edit" {
		t.Fatalf("request = %+v", got)
	}
	var resp ReplaceTaskResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ID != "n1" || resp.ReplacedTaskID != "t1" || !reflect.DeepEqual(resp.RemovedTaskIDs, []string{"t2", "t1"}) {
		t.Fatalf("response = %+v", resp)
	}

	for _, tc := range []struct {
		name, method, path, body string
		err                      error
		want                     int
	}{
		{"blank text", http.MethodPost, "/tasks/t1/replace", `{"task":"   ","topic_id":"topic-1"}`, nil, http.StatusBadRequest},
		{"no topic", http.MethodPost, "/tasks/t1/replace", `{"task":"edited"}`, nil, http.StatusBadRequest},
		{"bad json", http.MethodPost, "/tasks/t1/replace", `{`, nil, http.StatusBadRequest},
		{"no task id", http.MethodPost, "/tasks/%20/replace", `{"task":"edited","topic_id":"topic-1"}`, nil, http.StatusBadRequest},
		{"GET", http.MethodGet, "/tasks/t1/replace", ``, nil, http.StatusMethodNotAllowed},
		{"message gone", http.MethodPost, "/tasks/t1/replace", `{"task":"edited","topic_id":"topic-1"}`, ErrMessageNotFound, http.StatusNotFound},
		{"topic gone", http.MethodPost, "/tasks/t1/replace", `{"task":"edited","topic_id":"topic-1"}`, ErrTopicNotFound, http.StatusNotFound},
		{"topic running", http.MethodPost, "/tasks/t1/replace", `{"task":"edited","topic_id":"topic-1"}`, fmt.Errorf("replace: %w", ErrTopicRunning), http.StatusConflict},
		{"refused", http.MethodPost, "/tasks/t1/replace", `{"task":"/reset","topic_id":"topic-1"}`, BadRequest("no commands"), http.StatusBadRequest},
		{"failed", http.MethodPost, "/tasks/t1/replace", `{"task":"edited","topic_id":"topic-1"}`, errors.New("bus closed"), http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got = ReplaceTaskRequest{}
			replaceErr = tc.err
			rec := replaceRequest(t, mux, tc.method, tc.path, tc.body)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.want, rec.Body.String())
			}
			if tc.err == nil && got.TaskID != "" {
				t.Fatalf("a refused request reached Replace: %+v", got)
			}
		})
	}
}
