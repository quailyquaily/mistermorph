package llmstats

import (
	"strings"

	uniaiapi "github.com/quailyquaily/uniai"
)

func backfillRequestCost(rec RequestRecord, pricing *uniaiapi.PricingCatalog) RequestRecord {
	rec = normalizeRequestRecord(rec)
	if pricing == nil || requestRecordHasCost(rec) || rec.Operation != operationChat {
		return rec
	}
	usage := uniaiapi.Usage{
		InputTokens:  int(rec.InputTokens),
		OutputTokens: int(rec.OutputTokens),
		TotalTokens:  int(rec.TotalTokens),
		Cache: uniaiapi.UsageCache{
			CachedInputTokens:        int(rec.CachedInputTokens),
			CacheCreationInputTokens: int(rec.CacheCreationInputTokens),
			Details:                  toIntMap(rec.CacheDetails),
		},
	}
	cost, ok := pricing.EstimateChatCost(rec.Model, usage)
	if !ok || cost == nil {
		return rec
	}
	rec.CostCurrency = cost.Currency
	rec.CostEstimated = cost.Estimated
	rec.InputCost = cost.Input
	rec.CachedInputCost = cost.CachedInput
	rec.CacheCreationInputCost = cost.CacheCreationInput
	rec.OutputCost = cost.Output
	rec.TotalCost = cost.Total
	return normalizeRequestRecord(rec)
}

func requestRecordHasCost(rec RequestRecord) bool {
	return strings.TrimSpace(rec.CostCurrency) != "" ||
		rec.CostEstimated ||
		rec.InputCost != 0 ||
		rec.CachedInputCost != 0 ||
		rec.CacheCreationInputCost != 0 ||
		rec.OutputCost != 0 ||
		rec.TotalCost != 0
}

func toIntMap(in map[string]int64) map[string]int {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]int, len(in))
	for key, value := range in {
		out[key] = int(nonNegative(value))
	}
	return out
}
