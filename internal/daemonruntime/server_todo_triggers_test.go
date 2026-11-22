package daemonruntime

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// PUT /todo/tasks takes a job's triggers, uses and join and answers with the jobs as stored; a
// client that sends only at, cron and tz is served as it always was.
func TestTodoTasksRouteTriggersAndLegacyFields(t *testing.T) {
	mux := todoJobsMux(t, t.TempDir())
	code, saved, body := todoJobsCall(t, mux, http.MethodPut, `{"tasks":[
		{"id":"fetch","content":"Fetch","cron":"0 0 * * *","triggers":[
			{"kind":"schedule","cron":"0 9 * * *","tz":"UTC"},
			{"kind":"schedule","at":"2030-01-01 10:00"},
			{"id":"hook","kind":"poke"},
			{"kind":"message","channel":"telegram","chat_id":"tg:-1"}]},
		{"id":"report","content":"Report","triggers":[],"uses":[{"job_id":"fetch"}],"join":"any"},
		{"id":"old","content":"Old client","cron":"*/5 * * * *"}]}`)
	if code != http.StatusOK || len(saved.Tasks) != 3 {
		t.Fatalf("PUT = %d %s", code, body)
	}
	fetch, report, old := saved.Tasks[0], saved.Tasks[1], saved.Tasks[2]
	if fetch.Cron != "0 9 * * *" || fetch.TZ != "UTC" || fetch.At != "" || len(fetch.Triggers) != 4 {
		t.Fatalf("fetch = %+v", fetch)
	}
	for _, trigger := range fetch.Triggers {
		if trigger.ID == "" {
			t.Fatalf("trigger without id: %+v", trigger)
		}
	}
	if fetch.Triggers[2].ID != "hook" || fetch.Triggers[3].Channel != "telegram" || fetch.Triggers[3].ChatID != "tg:-1" {
		t.Fatalf("fetch triggers = %+v", fetch.Triggers)
	}
	if report.At != "" || report.Cron != "" || report.Triggers == nil || len(report.Triggers) != 0 || report.Join != cronstore.JoinAny ||
		len(report.Uses) != 1 || report.Uses[0] != (cronstore.Use{JobID: "fetch"}) {
		t.Fatalf("report = %+v", report)
	}
	if !strings.Contains(body, `"id":"report","title":"Unititled TODO","content":"Report","triggers":[],"uses":[{"job_id":"fetch"}],"join":"any"`) {
		t.Fatalf("report JSON not as documented: %s", body)
	}
	wantOld := []cronstore.Trigger{{ID: cronstore.LegacyScheduleTriggerID, Kind: cronstore.TriggerSchedule, Cron: "*/5 * * * *"}}
	if old.Cron != "*/5 * * * *" || len(old.Triggers) != 1 || old.Triggers[0] != wantOld[0] {
		t.Fatalf("old = %+v", old)
	}

	// GET answers the same jobs.
	code, read, body := todoJobsCall(t, mux, http.MethodGet, "")
	if code != http.StatusOK || len(read.Tasks) != 3 || len(read.Tasks[0].Triggers) != 4 || read.Tasks[0].Triggers[0].ID != fetch.Triggers[0].ID {
		t.Fatalf("GET = %d %s", code, body)
	}

	// An old client saves the list with only the fields it knows, one schedule edited: the edit
	// lands on the first schedule trigger and nothing it could not see is lost.
	code, saved, body = todoJobsCall(t, mux, http.MethodPut, `{"tasks":[
		{"id":"fetch","content":"Fetch","cron":"30 6 * * *","tz":"UTC"},
		{"id":"report","content":"Report, edited"},
		{"id":"old","content":"Old client","at":"2031-01-01 08:00"}]}`)
	if code != http.StatusOK || len(saved.Tasks) != 3 {
		t.Fatalf("legacy PUT = %d %s", code, body)
	}
	fetch, report, old = saved.Tasks[0], saved.Tasks[1], saved.Tasks[2]
	if fetch.Cron != "30 6 * * *" || len(fetch.Triggers) != 4 || fetch.Triggers[0].Cron != "30 6 * * *" || fetch.Triggers[2].ID != "hook" {
		t.Fatalf("fetch after a legacy save = %+v", fetch)
	}
	if report.Content != "Report, edited" || len(report.Uses) != 1 || report.Join != cronstore.JoinAny || len(report.Triggers) != 0 {
		t.Fatalf("report after a legacy save = %+v", report)
	}
	if old.At != "2031-01-01 08:00" || old.Cron != "" || len(old.Triggers) != 1 || old.Triggers[0].At != "2031-01-01 08:00" {
		t.Fatalf("old after a legacy save = %+v", old)
	}
}

// A save that does not validate is a 400 whose body says what is wrong, and changes nothing.
func TestTodoTasksRouteRefusesInvalidTriggersAndUses(t *testing.T) {
	seed := `{"id":"a","content":"A","cron":"0 9 * * *"},{"id":"b","content":"B","triggers":[],"uses":[{"job_id":"a"}]}`
	cases := []struct {
		name  string
		tasks string
		want  string
	}{
		{"unknown job", `{"id":"a","content":"A","triggers":[],"uses":[{"job_id":"ghost"}]}`, "task a uses unknown job: ghost"},
		{"itself", `{"id":"a","content":"A","triggers":[],"uses":[{"job_id":"a"}]}`, "task a cannot use itself"},
		{"a loop", `{"id":"a","content":"A","triggers":[],"uses":[{"job_id":"b"}]},{"id":"b","content":"B","triggers":[],"uses":[{"job_id":"a"}]}`,
			"jobs use each other in a loop: a -> b -> a"},
		{"twice", `{"id":"a","content":"A","cron":"0 9 * * *"},{"id":"b","content":"B","triggers":[],"uses":[{"job_id":"a"},{"job_id":"a"}]}`,
			"task b uses job a more than once"},
		{"unknown join", `{"id":"a","content":"A","triggers":[],"join":"some"}`, `unknown join "some"`},
		{"unknown kind", `{"id":"a","content":"A","triggers":[{"kind":"webhook"}]}`, `unknown trigger kind "webhook"`},
		{"deleting a job once nothing uses it", `{"id":"b","content":"B","triggers":[]}`, ""},
		{"deleting a job another still uses", `{"id":"b","content":"B","triggers":[],"uses":[{"job_id":"a"}]}`,
			"a is used by b; remove it from their uses first"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := todoJobsMux(t, t.TempDir())
			if code, _, body := todoJobsCall(t, mux, http.MethodPut, `{"tasks":[`+seed+`]}`); code != http.StatusOK {
				t.Fatalf("seed = %d %s", code, body)
			}
			code, _, body := todoJobsCall(t, mux, http.MethodPut, `{"tasks":[`+tc.tasks+`]}`)
			if tc.want == "" {
				if code != http.StatusOK {
					t.Fatalf("PUT = %d %s", code, body)
				}
				return
			}
			if code != http.StatusBadRequest || !strings.Contains(body, tc.want) {
				t.Fatalf("PUT = %d %q, want 400 with %q", code, body, tc.want)
			}
			_, read, _ := todoJobsCall(t, mux, http.MethodGet, "")
			if raw, _ := json.Marshal(read.Tasks); len(read.Tasks) != 2 || len(read.Tasks[1].Uses) != 1 {
				t.Fatalf("list after a refused save = %s", raw)
			}
		})
	}
	t.Run("more than eight uses", func(t *testing.T) {
		mux := todoJobsMux(t, t.TempDir())
		var jobs, uses []string
		for _, id := range []string{"j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9"} {
			jobs = append(jobs, `{"id":"`+id+`","content":"x","triggers":[]}`)
			uses = append(uses, `{"job_id":"`+id+`"}`)
		}
		jobs = append(jobs, `{"id":"all","content":"x","triggers":[],"uses":[`+strings.Join(uses, ",")+`]}`)
		code, _, body := todoJobsCall(t, mux, http.MethodPut, `{"tasks":[`+strings.Join(jobs, ",")+`]}`)
		if code != http.StatusBadRequest || !strings.Contains(body, "task all uses 9 jobs; the limit is 8") {
			t.Fatalf("PUT = %d %q", code, body)
		}
	})
}
