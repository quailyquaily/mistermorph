package contacts

import (
	"sort"
	"strings"
)

const (
	maxTopicWeights = 16
)

type weightedTopic struct {
	Topic string
	Score float64
}

func normalizeTopicWeightsMap(weights map[string]float64) map[string]float64 {
	if len(weights) == 0 {
		return nil
	}
	items := make([]weightedTopic, 0, len(weights))
	for rawTopic, rawScore := range weights {
		topic := strings.ToLower(strings.TrimSpace(rawTopic))
		if topic == "" {
			continue
		}
		score := clamp(rawScore, 0, 1)
		if score <= 0 {
			continue
		}
		items = append(items, weightedTopic{Topic: topic, Score: score})
	}
	if len(items) == 0 {
		return nil
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Score == items[j].Score {
			return items[i].Topic < items[j].Topic
		}
		return items[i].Score > items[j].Score
	})
	if len(items) > maxTopicWeights {
		items = items[:maxTopicWeights]
	}
	out := make(map[string]float64, len(items))
	for _, item := range items {
		// sorted items keep the first (highest score) when same topic appears.
		if _, exists := out[item.Topic]; exists {
			continue
		}
		out[item.Topic] = item.Score
	}
	return out
}
