package llmstats

import (
	"math"
	"strings"

	uniaiapi "github.com/quailyquaily/uniai"
)

func backfillRequestCost(rec RequestRecord, pricing *uniaiapi.PricingCatalog) RequestRecord {
	rec = normalizeRequestRecord(rec)
	if pricing == nil || requestRecordHasCost(rec) || !catalogPriced(rec.Operation) {
		return rec
	}
	cost, ok := catalogCost(rec, pricing)
	if !ok {
		return rec
	}
	rec.CostCurrency = cost.Currency
	// A coder's cost is a list price on a subscription, never what is billed.
	rec.CostEstimated = cost.Estimated || rec.Operation == OperationCoder
	rec.InputCost = cost.Input
	rec.CachedInputCost = cost.CachedInput
	rec.CacheCreationInputCost = cost.CacheCreationInput
	rec.OutputCost = cost.Output
	rec.TotalCost = cost.Total
	return normalizeRequestRecord(rec)
}

// catalogCost is the catalog's price of a record. A record that sums several upstream requests
// (PricingParts) is the sum of their prices, each priced as the request it was: a catalog's tiers
// go by one request's input tokens, which a sum of requests would cross without any of them
// having. When one part has no price, the record has none.
func catalogCost(rec RequestRecord, pricing *uniaiapi.PricingCatalog) (uniaiapi.UsageCost, bool) {
	if len(rec.PricingParts) == 0 {
		cost, ok := pricing.EstimateChatCost(rec.Model, uniaiapi.Usage{
			InputTokens:  int(rec.InputTokens),
			OutputTokens: int(rec.OutputTokens),
			TotalTokens:  int(rec.TotalTokens),
			Cache: uniaiapi.UsageCache{
				CachedInputTokens:        int(rec.CachedInputTokens),
				CacheCreationInputTokens: int(rec.CacheCreationInputTokens),
				Details:                  toIntMap(rec.CacheDetails),
			},
		})
		if !ok || cost == nil {
			return uniaiapi.UsageCost{}, false
		}
		return *cost, true
	}
	var sum uniaiapi.UsageCost
	for _, part := range rec.PricingParts {
		cost, ok := pricing.EstimateChatCost(rec.Model, uniaiapi.Usage{
			InputTokens:  int(part.InputTokens),
			OutputTokens: int(part.OutputTokens),
			TotalTokens:  int(part.InputTokens + part.OutputTokens),
			Cache: uniaiapi.UsageCache{
				CachedInputTokens:        int(part.CachedInputTokens),
				CacheCreationInputTokens: int(part.CacheCreationInputTokens),
				Details:                  toIntMap(part.CacheDetails),
			},
		})
		if !ok || cost == nil {
			return uniaiapi.UsageCost{}, false
		}
		if sum.Currency != "" && cost.Currency != sum.Currency {
			return uniaiapi.UsageCost{}, false
		}
		n := float64(part.count())
		sum.Currency = cost.Currency
		sum.Estimated = sum.Estimated || cost.Estimated
		sum.Input += n * cost.Input
		sum.CachedInput += n * cost.CachedInput
		sum.CacheCreationInput += n * cost.CacheCreationInput
		sum.Output += n * cost.Output
	}
	// A part taken back can outweigh the row's others only when the row's own tokens were cut
	// at 0 too: its cost is cut the same way.
	sum.Input = roundCost(max(sum.Input, 0))
	sum.CachedInput = roundCost(max(sum.CachedInput, 0))
	sum.CacheCreationInput = roundCost(max(sum.CacheCreationInput, 0))
	sum.Output = roundCost(max(sum.Output, 0))
	sum.Total = roundCost(sum.Input + sum.CachedInput + sum.CacheCreationInput + sum.Output)
	return sum, true
}

// roundCost rounds as the catalog rounds its own prices.
func roundCost(v float64) float64 {
	return math.Round(v*1e12) / 1e12
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
