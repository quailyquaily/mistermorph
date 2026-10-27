package domainjournal

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func taskEvent(id, typ, at, audience string, task map[string]any) Event {
	payload, _ := json.Marshal(map[string]any{"task": task})
	return Event{
		ID:            id,
		Time:          at,
		Domain:        "task",
		Type:          typ,
		SchemaVersion: 1,
		Trace:         Trace{TaskID: fmt.Sprint(task["id"])},
		Audience:      audience,
		Payload:       payload,
	}
}

func TestSearchTextIndexesEachPieceOnce(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	at := "2026-10-01T10:00:00Z"
	events := []Event{
		taskEvent("e1", "task_upsert", at, "", map[string]any{"id": "t1", "status": "queued", "task": "Where are the release notes?"}),
		taskEvent("e2", "task_update", at, "", map[string]any{"id": "t1", "status": "running", "task": "Where are the release notes?",
			"result": map[string]any{"trace": "fetched https://example.com/secret-tool-output"}}),
		taskEvent("e3", "task_update", at, "", map[string]any{"id": "t1", "status": "running", "task": "Where are the release notes?"}),
		taskEvent("e4", "task_update", at, "", map[string]any{"id": "t1", "status": "done", "task": "Where are the release notes?",
			"result": map[string]any{"final": map[string]any{"output": "They are in the wiki under Releases."}, "trace": "secret-tool-output"}}),
		{ID: "e5", Time: at, Domain: "conversation", Type: "untriggered_inbound", SchemaVersion: 1,
			Payload: json.RawMessage(`{"channel":"telegram","text":"anyone seen the release notes"}`)},
		{ID: "e6", Time: at, Domain: "contacts", Type: "agent_pair_requested", SchemaVersion: 1,
			Payload: json.RawMessage(`{"note":"release notes"}`)},
	}
	for _, event := range events {
		if _, err := j.Append(event); err != nil {
			t.Fatalf("Append(%s) error = %v", event.ID, err)
		}
	}

	hits, _, err := j.Search(SearchOptions{Query: "release notes", AllAudiences: true})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if got, want := hitIDs(hits), "e5,e1"; got != want {
		t.Fatalf("Search(release notes) = %s, want %s (each piece once, newest first)", got, want)
	}
	hits, _, err = j.Search(SearchOptions{Query: "wiki", AllAudiences: true})
	if err != nil || hitIDs(hits) != "e4" {
		t.Fatalf("Search(wiki) = %s, %v; want e4", hitIDs(hits), err)
	}
	if hits, _, _ := j.Search(SearchOptions{Query: "secret-tool-output", AllAudiences: true}); len(hits) != 0 {
		t.Fatalf("Search(trace text) = %s, want nothing: traces are not indexed", hitIDs(hits))
	}
}

func TestSearchMatchesCJKAndShortTerms(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	at := "2026-10-01T10:00:00Z"
	for i, text := range []string{"明日の会議は十時から", "リリースノートはDMで送る"} {
		if _, err := j.Append(taskEvent(fmt.Sprintf("e%d", i+1), "task_upsert", at, "", map[string]any{"id": fmt.Sprintf("t%d", i), "task": text})); err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}
	for query, want := range map[string]string{
		"リリース":      "e2",
		"会議":        "e1",
		"DM":        "e2",
		"会議 十時":     "e1",
		"会議 リリース":   "",
		"100%_done": "",
	} {
		hits, _, err := j.Search(SearchOptions{Query: query, AllAudiences: true})
		if err != nil {
			t.Fatalf("Search(%q) error = %v", query, err)
		}
		if got := hitIDs(hits); got != want {
			t.Fatalf("Search(%q) = %q, want %q", query, got, want)
		}
	}
}

func TestSearchRespectsAudiences(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	at := "2026-10-01T10:00:00Z"
	for _, tc := range []struct{ id, audience string }{
		{"owner_unset", ""},
		{"owner_set", "owner"},
		{"alice_dm", "contact:alice"},
		{"group_g", "conversation:telegram:g"},
	} {
		if _, err := j.Append(taskEvent(tc.id, "task_upsert", at, tc.audience, map[string]any{"id": tc.id, "task": "the plan for friday"})); err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}
	for name, tc := range map[string]struct {
		opts SearchOptions
		want string
	}{
		"owner sees all":        {SearchOptions{AllAudiences: true}, "group_g,alice_dm,owner_set,owner_unset"},
		"owner audience":        {SearchOptions{Audiences: []string{"owner"}}, "owner_set,owner_unset"},
		"alice sees her dm":     {SearchOptions{Audiences: []string{"contact:alice"}}, "alice_dm"},
		"group sees the group":  {SearchOptions{Audiences: []string{"conversation:telegram:g"}}, "group_g"},
		"no audience sees none": {SearchOptions{}, ""},
		"unknown sees none":     {SearchOptions{Audiences: []string{"contact:bob"}}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			tc.opts.Query = "friday"
			hits, _, err := j.Search(tc.opts)
			if err != nil {
				t.Fatalf("Search() error = %v", err)
			}
			if got := hitIDs(hits); got != tc.want {
				t.Fatalf("Search() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSearchTimeDomainAndLimit(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		at := base.Add(time.Duration(i) * 24 * time.Hour).Format(time.RFC3339Nano)
		if _, err := j.Append(taskEvent(fmt.Sprintf("day%d", i), "task_upsert", at, "", map[string]any{"id": fmt.Sprintf("t%d", i), "task": "daily standup"})); err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}
	hits, more, err := j.Search(SearchOptions{
		Query:        "standup",
		AllAudiences: true,
		Since:        base.Add(24 * time.Hour),
		Until:        base.Add(4 * 24 * time.Hour),
		Domain:       "task",
		Limit:        2,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if got := hitIDs(hits); got != "day3,day2" || !more {
		t.Fatalf("Search() = %q more=%v, want day3,day2 with more", got, more)
	}
	if hits, _, _ := j.Search(SearchOptions{Query: "standup", AllAudiences: true, Domain: "conversation"}); len(hits) != 0 {
		t.Fatalf("Search(domain conversation) = %q, want none", hitIDs(hits))
	}
}

func TestSearchByIDs(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	at := "2026-10-01T10:00:00Z"
	for _, id := range []string{"a", "b", "c"} {
		if _, err := j.Append(taskEvent(id, "task_upsert", at, "contact:alice", map[string]any{"id": id, "task": "the plan for friday"})); err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}
	// An event with no text is still found by its ID.
	if _, err := j.Append(taskEvent("quiet", "task_update", at, "", map[string]any{"id": "quiet"})); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	for name, tc := range map[string]struct {
		opts SearchOptions
		want string
	}{
		"only those ids":            {SearchOptions{AllAudiences: true, IDs: []string{"a", "c", "quiet", " "}}, "quiet,c,a"},
		"ids and a query":           {SearchOptions{AllAudiences: true, IDs: []string{"a", "quiet"}, Query: "friday"}, "a"},
		"ids the audience hears":    {SearchOptions{Audiences: []string{"contact:alice"}, IDs: []string{"b", "quiet"}}, "b"},
		"unknown ids match none":    {SearchOptions{AllAudiences: true, IDs: []string{"nope"}}, ""},
		"blank ids search as usual": {SearchOptions{AllAudiences: true, IDs: []string{""}}, "c,b,a"},
	} {
		t.Run(name, func(t *testing.T) {
			hits, _, err := j.Search(tc.opts)
			if err != nil {
				t.Fatalf("Search() error = %v", err)
			}
			if got := hitIDs(hits); got != tc.want {
				t.Fatalf("Search() = %q, want %q", got, tc.want)
			}
		})
	}
}

func hitIDs(hits []SearchHit) string {
	ids := make([]string, 0, len(hits))
	for _, hit := range hits {
		ids = append(ids, hit.ID)
	}
	return strings.Join(ids, ",")
}
