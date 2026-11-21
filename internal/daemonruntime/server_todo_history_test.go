package daemonruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

func todoGet(t *testing.T, mux *http.ServeMux, target, token string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestTodoRunHistoryRoute(t *testing.T) {
	stateDir := t.TempDir()
	mux := todoJobsMux(t, stateDir)
	store := cronstore.NewStore(testRuntimePaths(stateDir).CronPath)
	base := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	seed := []cronstore.RunRecord{
		{RunID: "r1", JobID: "a", Status: cronstore.RunStatusDone, QueuedAt: cronstore.RunTime(base),
			StartedAt: cronstore.RunTime(base.Add(time.Second)), FinishedAt: cronstore.RunTime(base.Add(time.Minute)),
			Cause: cronstore.RunCause{Kind: cronstore.CauseSchedule, TriggerID: "trg-schedule"}},
		{RunID: "r2", JobID: "b", Status: cronstore.RunStatusFailed, QueuedAt: cronstore.RunTime(base.Add(time.Hour)), Error: "boom",
			Cause: cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: "a", OriginRunID: "r1"}},
		{RunID: "r3", JobID: "a", Status: cronstore.RunStatusQueued, QueuedAt: cronstore.RunTime(base.Add(2 * time.Hour)),
			Cause: cronstore.RunCause{Kind: cronstore.CauseManual}},
		{RunID: "r4", JobID: "c", Status: cronstore.RunStatusSkipped, QueuedAt: cronstore.RunTime(base.Add(3 * time.Hour)),
			FinishedAt: cronstore.RunTime(base.Add(3 * time.Hour)),
			Cause:      cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: "b", OriginRunID: "r1", Note: "input job b failed"}},
	}
	for _, run := range seed {
		if _, err := store.RecordRun(context.Background(), run); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		name     string
		query    string
		token    string
		wantCode int
		wantIDs  string
		wantBody string
	}{
		{"everything, newest first", "", "token", 200, "r4,r3,r2,r1", ""},
		{"one job", "?job_id=a", "token", 200, "r3,r1", ""},
		{"an unknown job", "?job_id=ghost", "token", 200, "", `"items":[]`},
		{"from", "?from=2030-01-01T01:00:00Z", "token", 200, "r4,r3,r2", ""},
		{"to is exclusive", "?to=2030-01-01T02:00:00Z", "token", 200, "r2,r1", ""},
		{"a window with an offset", "?from=2030-01-01T09:00:00%2B08:00&to=2030-01-01T03:00:00Z", "token", 200, "r3,r2", ""},
		{"a window and a job", "?job_id=a&from=2030-01-01T01:00:00Z&to=2030-01-02T00:00:00Z", "token", 200, "r3", ""},
		{"a limit", "?limit=2", "token", 200, "r4,r3", `"limit":2`},
		{"the default limit is reported", "", "token", 200, "r4,r3,r2,r1", fmt.Sprintf(`"limit":%d`, cronstore.RunHistoryDefaultLimit)},
		{"a bad from", "?from=yesterday", "token", 400, "", "invalid from"},
		{"a bad to", "?to=2030-01-01", "token", 400, "", "invalid to"},
		{"from after to", "?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z", "token", 400, "", "from must be before to"},
		{"a bad limit", "?limit=0", "token", 400, "", "invalid limit"},
		{"a limit too large", "?limit=501", "token", 400, "", "invalid limit"},
		{"no token", "", "", 401, "", ""},
		{"a wrong token", "", "nope", 401, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, body := todoGet(t, mux, "/todo/runs/history"+tc.query, tc.token)
			if code != tc.wantCode || !strings.Contains(body, tc.wantBody) {
				t.Fatalf("GET = %d %s", code, body)
			}
			if code != http.StatusOK {
				return
			}
			var payload struct {
				Items []cronstore.RunRecord `json:"items"`
			}
			if err := json.Unmarshal([]byte(body), &payload); err != nil {
				t.Fatal(err)
			}
			ids := make([]string, 0, len(payload.Items))
			for _, run := range payload.Items {
				ids = append(ids, run.RunID)
			}
			if strings.Join(ids, ",") != tc.wantIDs {
				t.Fatalf("items = %v, want %s", ids, tc.wantIDs)
			}
		})
	}

	t.Run("the shape of an entry", func(t *testing.T) {
		_, body := todoGet(t, mux, "/todo/runs/history?job_id=c", "token")
		want := `{"items":[{"run_id":"r4","job_id":"c","status":"skipped","queued_at":"2030-01-01T03:00:00Z","finished_at":"2030-01-01T03:00:00Z",` +
			`"cause":{"kind":"job","trigger_id":"","from_job_id":"b","origin_run_id":"r1","note":"input job b failed"}}],"limit":50}`
		if strings.TrimSpace(body) != want {
			t.Fatalf("body = %s\nwant %s", body, want)
		}
		_, body = todoGet(t, mux, "/todo/runs/history?job_id=a&limit=1&to=2030-01-01T00:30:00Z", "token")
		want = `{"items":[{"run_id":"r1","job_id":"a","status":"done","queued_at":"2030-01-01T00:00:00Z","started_at":"2030-01-01T00:00:01Z","finished_at":"2030-01-01T00:01:00Z",` +
			`"cause":{"kind":"schedule","trigger_id":"trg-schedule","from_job_id":"","origin_run_id":"r1","note":""}}],"limit":1}`
		if strings.TrimSpace(body) != want {
			t.Fatalf("body = %s\nwant %s", body, want)
		}
	})

	t.Run("only GET", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/todo/runs/history", nil)
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST = %d", rec.Code)
		}
	})
}

// GET /todo/runs keeps its entries and adds each one's cause, for held runs and ended ones.
func TestTodoRunsRouteShowsTheCause(t *testing.T) {
	stateDir := t.TempDir()
	paths := testRuntimePaths(stateDir)
	board := &cronstore.RunBoard{}
	defer cronstore.RegisterRunBoard(paths.CronPath, board)()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	doneID := board.Queue("ended", false, now)
	board.Start("ended", doneID, now, nil)
	board.Finish("ended", doneID, cronstore.RunStatusDone, now)
	pokeID, _ := board.QueueRun("poked", cronstore.RunCause{Kind: cronstore.CausePoke, TriggerID: "hook"}, now)
	board.QueueRun("chained", cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: "poked", OriginRunID: pokeID}, now.Add(time.Second))

	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", RuntimePaths: paths})
	code, body := todoGet(t, mux, "/todo/runs", "token")
	if code != http.StatusOK {
		t.Fatalf("GET = %d %s", code, body)
	}
	var payload struct {
		Runs     []cronstore.TaskRun     `json:"runs"`
		Finished []cronstore.FinishedRun `json:"finished"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Runs) != 2 || len(payload.Finished) != 1 {
		t.Fatalf("payload = %s", body)
	}
	if got, want := payload.Runs[0].Cause, (cronstore.RunCause{Kind: cronstore.CausePoke, TriggerID: "hook", OriginRunID: pokeID}); got != want || payload.Runs[0].ID != "poked" {
		t.Fatalf("poked = %+v", payload.Runs[0])
	}
	if got, want := payload.Runs[1].Cause, (cronstore.RunCause{Kind: cronstore.CauseJob, FromJobID: "poked", OriginRunID: pokeID}); got != want {
		t.Fatalf("chained = %+v", payload.Runs[1])
	}
	if got, want := payload.Finished[0].Cause, (cronstore.RunCause{Kind: cronstore.CauseSchedule, OriginRunID: doneID}); got != want {
		t.Fatalf("finished = %+v", payload.Finished[0])
	}
	wantEntry := `{"id":"poked","run_id":"` + pokeID + `","state":"queued","cause":{"kind":"poke","trigger_id":"hook","from_job_id":"","origin_run_id":"` + pokeID + `","note":""},"queued_at":"2026-11-04T12:00:00Z","started_at":"0001-01-01T00:00:00Z"}`
	if !strings.Contains(body, wantEntry) {
		t.Fatalf("entry not as documented:\n%s\nwant %s", body, wantEntry)
	}
}
