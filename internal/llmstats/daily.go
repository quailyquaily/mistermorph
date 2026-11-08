package llmstats

const (
	DefaultDailyDays = 30
	MaxDailyDays     = 366
)

// DaySummary totals the requests made on one calendar day in the requested time zone,
// overall and per model.
type DaySummary struct {
	Date string `json:"date"`
	Totals
	Models []ModelSummary `json:"models,omitempty"`
}

// DailyUsage is a dense run of days, oldest first; days without requests carry zero totals.
type DailyUsage struct {
	TimeZone string         `json:"time_zone"`
	From     string         `json:"from"`
	To       string         `json:"to"`
	Days     []DaySummary   `json:"days"`
	Summary  Totals         `json:"summary"`
	Models   []ModelSummary `json:"models,omitempty"`
}

func addModelRecord(byModel map[string]*Totals, rec RequestRecord) {
	totals, ok := byModel[rec.Model]
	if !ok {
		totals = &Totals{}
		byModel[rec.Model] = totals
	}
	totals.AddRecord(rec)
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
