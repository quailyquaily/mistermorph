package llmstats

const (
	DefaultDailyDays = 30
	MaxDailyDays     = 366
)

// DaySummary totals the requests made on one calendar day in the requested time zone,
// overall and per model. Sources has the same apart for the agent's own calls and for coder runs.
type DaySummary struct {
	Date string `json:"date"`
	Totals
	Models  []ModelSummary  `json:"models,omitempty"`
	Sources DaySourceUsages `json:"sources"`
}

// DaySourceUsage is one source's usage on one day.
type DaySourceUsage struct {
	Totals Totals         `json:"totals"`
	Models []ModelSummary `json:"models"`
}

// DaySourceUsages is a day's usage by source. Both are always present, with zero totals when the
// source has no rows.
type DaySourceUsages struct {
	Agent DaySourceUsage `json:"agent"`
	Coder DaySourceUsage `json:"coder"`
}

// SourceUsage is one source's usage over the range.
type SourceUsage struct {
	Summary Totals         `json:"summary"`
	Models  []ModelSummary `json:"models"`
}

// SourceUsages is the range's usage by source: the agent's own calls, and coder runs
// (operation OperationCoder).
type SourceUsages struct {
	Agent SourceUsage `json:"agent"`
	Coder SourceUsage `json:"coder"`
}

// DailyUsage is a dense run of days, oldest first; days without requests carry zero totals.
type DailyUsage struct {
	TimeZone string         `json:"time_zone"`
	From     string         `json:"from"`
	To       string         `json:"to"`
	Days     []DaySummary   `json:"days"`
	Summary  Totals         `json:"summary"`
	Models   []ModelSummary `json:"models,omitempty"`
	// Sources splits Summary and Models (and each day's) into agent and coder; the combined
	// fields are their sums.
	Sources SourceUsages `json:"sources"`
}

func addModelRecord(byModel map[string]*Totals, rec RequestRecord) {
	totals, ok := byModel[rec.Model]
	if !ok {
		totals = &Totals{}
		byModel[rec.Model] = totals
	}
	totals.AddRecord(rec)
}

// sourceModelSummaries is modelSummaries with an empty list rather than none, as the sources'
// model lists are always present.
func sourceModelSummaries(byModel map[string]*Totals) []ModelSummary {
	if out := modelSummaries(byModel); out != nil {
		return out
	}
	return []ModelSummary{}
}

func modelSummaries(byModel map[string]*Totals) []ModelSummary {
	if len(byModel) == 0 {
		return nil
	}
	out := make([]ModelSummary, 0, len(byModel))
	for model, totals := range byModel {
		out = append(out, ModelSummary{Model: model, Totals: *totals})
	}
	sortModelSummaries(out)
	return out
}
