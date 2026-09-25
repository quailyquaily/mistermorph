package llmstats

import (
	"time"
)

const (
	DefaultDailyDays = 30
	MaxDailyDays     = 366
)

// DaySummary totals the requests made on one calendar day in the requested time zone.
type DaySummary struct {
	Date string `json:"date"`
	Totals
}

// DailyUsage is a dense run of days, oldest first; days without requests carry zero totals.
type DailyUsage struct {
	TimeZone string       `json:"time_zone"`
	From     string       `json:"from"`
	To       string       `json:"to"`
	Days     []DaySummary `json:"days"`
	Summary  Totals       `json:"summary"`
}

// Daily scans the journal and totals the last `days` calendar days (today included) in loc.
// It reads the journal directly rather than the projection, so any time zone can be served
// without storing per-zone buckets.
func (s *ProjectionStore) Daily(days int, loc *time.Location) (DailyUsage, error) {
	if days <= 0 {
		days = DefaultDailyDays
	}
	if days > MaxDailyDays {
		days = MaxDailyDays
	}
	if loc == nil {
		loc = time.UTC
	}
	now := time.Now
	if s.now != nil {
		now = s.now
	}
	today := now().In(loc)
	lastDay := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc)
	firstDay := lastDay.AddDate(0, 0, -(days - 1))

	out := DailyUsage{
		TimeZone: loc.String(),
		From:     firstDay.Format(time.DateOnly),
		To:       lastDay.Format(time.DateOnly),
		Days:     make([]DaySummary, days),
	}
	index := make(map[string]int, days)
	for i := range out.Days {
		date := firstDay.AddDate(0, 0, i).Format(time.DateOnly)
		out.Days[i].Date = date
		index[date] = i
	}

	pricing, _, err := s.currentPricing()
	if err != nil {
		return DailyUsage{}, err
	}
	segments, err := listSegmentFiles(s.journalDir)
	if err != nil {
		return DailyUsage{}, err
	}
	segments = segmentsReachingDate(segments, firstDay.UTC().AddDate(0, 0, -1).Format(time.DateOnly))
	_, _, err = scanJournalFrom(s.journalDir, segments, Offset{}, func(rec RequestRecord, _ Offset) error {
		ts, err := time.Parse(time.RFC3339, rec.TS)
		if err != nil {
			return nil
		}
		i, ok := index[ts.In(loc).Format(time.DateOnly)]
		if !ok {
			return nil
		}
		rec = backfillRequestCost(rec, pricing)
		out.Days[i].AddRecord(rec)
		out.Summary.AddRecord(rec)
		return nil
	})
	if err != nil {
		return DailyUsage{}, err
	}
	return out, nil
}

// segmentsReachingDate drops segments that end before date: a segment ends where the next one
// starts, so any segment followed by one that starts before date holds only older records.
func segmentsReachingDate(segments []journalSegmentFile, date string) []journalSegmentFile {
	for len(segments) > 1 && segments[1].Date != "" && segments[1].Date < date {
		segments = segments[1:]
	}
	return segments
}
