package llmstats

import (
	"path/filepath"
	"testing"
	"time"
)

func TestDailyBucketsByCalendarDayInZone(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	journalDir := filepath.Join(root, "journal")
	journal := NewJournal(journalDir, JournalOptions{MaxFileBytes: 1024 * 1024})
	journal.now = func() time.Time { return time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC) }
	defer func() { _ = journal.Close() }()

	appendAt := func(ts time.Time, input, output int64, cost float64) {
		t.Helper()
		model := "gpt-5.2"
		if cost < 1 {
			model = "gpt-5-mini"
		}
		_, err := journal.Append(RequestRecord{
			TS:                ts.UTC().Format(time.RFC3339),
			Provider:          "openai",
			APIBase:           "https://api.openai.com",
			Model:             model,
			InputTokens:       input,
			OutputTokens:      output,
			CachedInputTokens: input / 2,
			CostCurrency:      "USD",
			TotalCost:         cost,
		})
		if err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}

	// 2026-03-05 20:00 UTC is 2026-03-06 04:00 in Shanghai (UTC+8).
	appendAt(time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC), 100, 10, 1) // before the range
	appendAt(time.Date(2026, 3, 5, 10, 0, 0, 0, time.UTC), 100, 10, 1)
	appendAt(time.Date(2026, 3, 5, 20, 0, 0, 0, time.UTC), 200, 20, 2)
	appendAt(time.Date(2026, 3, 7, 1, 0, 0, 0, time.UTC), 40, 4, 0.5)

	store := NewProjectionStoreWithOptions(journalDir, filepath.Join(root, "projection.json"), ProjectionOptions{})
	store.now = func() time.Time { return time.Date(2026, 3, 7, 2, 0, 0, 0, time.UTC) }

	cases := []struct {
		zone     string
		wantDays map[string]int64 // date -> requests
		wantFrom string
	}{
		{zone: "UTC", wantFrom: "2026-03-04", wantDays: map[string]int64{"2026-03-04": 0, "2026-03-05": 2, "2026-03-06": 0, "2026-03-07": 1}},
		{zone: "Asia/Shanghai", wantFrom: "2026-03-04", wantDays: map[string]int64{"2026-03-04": 0, "2026-03-05": 1, "2026-03-06": 1, "2026-03-07": 1}},
	}
	for _, tc := range cases {
		t.Run(tc.zone, func(t *testing.T) {
			loc, err := time.LoadLocation(tc.zone)
			if err != nil {
				t.Skipf("zone %s unavailable: %v", tc.zone, err)
			}
			got, err := store.Daily(4, loc)
			if err != nil {
				t.Fatalf("Daily() error = %v", err)
			}
			if got.From != tc.wantFrom || got.To != "2026-03-07" || len(got.Days) != 4 {
				t.Fatalf("range = %s..%s (%d days), want %s..2026-03-07 (4 days)", got.From, got.To, len(got.Days), tc.wantFrom)
			}
			var total int64
			for _, day := range got.Days {
				if want := tc.wantDays[day.Date]; day.Requests != want {
					t.Fatalf("%s requests = %d, want %d", day.Date, day.Requests, want)
				}
				total += day.Requests
			}
			if got.Summary.Requests != total || got.Summary.Requests != 3 {
				t.Fatalf("summary requests = %d, want 3", got.Summary.Requests)
			}
			if got.Summary.TotalCost != 3.5 || got.Summary.TotalTokens != 374 {
				t.Fatalf("summary cost/tokens = %v/%d, want 3.5/374", got.Summary.TotalCost, got.Summary.TotalTokens)
			}
			if len(got.Models) != 2 || got.Models[0].Model != "gpt-5.2" || got.Models[0].Requests != 2 || got.Models[1].Model != "gpt-5-mini" || got.Models[1].TotalCost != 0.5 {
				t.Fatalf("range models = %+v", got.Models)
			}
			for _, day := range got.Days {
				var requests int64
				for _, model := range day.Models {
					requests += model.Requests
				}
				if requests != day.Requests {
					t.Fatalf("%s model requests = %d, day requests = %d", day.Date, requests, day.Requests)
				}
				if day.Requests == 0 && day.Models != nil {
					t.Fatalf("%s idle day has models %+v", day.Date, day.Models)
				}
			}
		})
	}
}

func TestDailyClampsDays(t *testing.T) {
	t.Parallel()

	store := NewProjectionStoreWithOptions(filepath.Join(t.TempDir(), "missing"), "", ProjectionOptions{})
	for _, tc := range []struct{ in, want int }{{0, DefaultDailyDays}, {-3, DefaultDailyDays}, {7, 7}, {5000, MaxDailyDays}} {
		got, err := store.Daily(tc.in, time.UTC)
		if err != nil {
			t.Fatalf("Daily(%d) error = %v", tc.in, err)
		}
		if len(got.Days) != tc.want {
			t.Fatalf("Daily(%d) days = %d, want %d", tc.in, len(got.Days), tc.want)
		}
	}
}

func TestSegmentsReachingDate(t *testing.T) {
	t.Parallel()

	segs := []journalSegmentFile{{Key: "a", Date: "2026-01-01"}, {Key: "b", Date: "2026-02-01"}, {Key: "c", Date: "2026-03-01"}}
	got := segmentsReachingDate(segs, "2026-02-15")
	if len(got) != 2 || got[0].Key != "b" {
		t.Fatalf("segmentsReachingDate = %+v, want from b", got)
	}
	if got := segmentsReachingDate(segs, "2025-12-01"); len(got) != 3 {
		t.Fatalf("early date dropped segments: %+v", got)
	}
}
