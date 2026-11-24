package daemonruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A message for a subagent carries its target to the runtime, and a refusal comes back as 409
// with the reason in `code`, so a client keeps the message and can offer another target.
func TestTasksRouteSteersAChildOrSaysWhyNot(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "console",
		AuthToken: "token", TaskTopic: TaskTopicRoutes{Submit: func(_ context.Context, req SubmitTaskRequest) (SubmitTaskResponse, error) {
			if req.SteerTargetChildID == "worker-1" {
				return SubmitTaskResponse{ID: "task_1", Status: TaskRunning, TopicID: req.TopicID, SteerTargetTaskID: "task_1", SteerTargetChildID: "worker-1", SteerTargetChildTaskID: "sub_1", SteerStatus: "queued"}, nil
			}
			return SubmitTaskResponse{}, &SteerRejectedError{Code: "child_finished", Message: "Curie has already finished, so your message was not sent.", TaskID: "task_1", ChildID: req.SteerTargetChildID, ChildName: "Curie"}
		}},
	})
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/tasks", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	rec := post(`{"task":"use metric units","topic_id":"topic_a","steer_target_child_id":"worker-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var queued map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &queued)
	if queued["steer_target_child_id"] != "worker-1" || queued["steer_status"] != "queued" || queued["steer_target_child_task_id"] != "sub_1" {
		t.Fatalf("payload = %v", queued)
	}

	rec = post(`{"task":"use metric units","topic_id":"topic_a","steer_target_child_id":"worker-2"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
	var refused map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &refused); err != nil {
		t.Fatalf("refusal is not JSON: %v (%s)", err, rec.Body.String())
	}
	if refused["code"] != "child_finished" || refused["child_id"] != "worker-2" || refused["child_name"] != "Curie" || !strings.Contains(refused["error"].(string), "finished") {
		t.Fatalf("refusal = %v", refused)
	}
}
