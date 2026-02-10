package memory

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
)

func TestBuildAndParseShortTermSummaryBody(t *testing.T) {
	content := ShortTermContent{
		SummaryItems: []SummaryItem{
			{Created: "2026-02-11 09:30", Content: "The agent discussed the proposal with [Alice](tg:@alice)."},
			{Created: "2026-02-11 09:40", Content: "The agent received review feedback from [Bob](tg:@bob)."},
		},
	}
	body := BuildShortTermBody(content)
	if !strings.Contains(body, "# Summary") {
		t.Fatalf("missing summary header: %q", body)
	}
	if !strings.Contains(body, "- [Created](2026-02-11 09:30) | The agent discussed the proposal with [Alice](tg:@alice).") {
		t.Fatalf("missing first summary item: %q", body)
	}

	parsed := ParseShortTermContent(body)
	if len(parsed.SummaryItems) != 2 {
		t.Fatalf("summary items count mismatch: got %d want 2", len(parsed.SummaryItems))
	}
	if parsed.SummaryItems[0].Created != "2026-02-11 09:30" {
		t.Fatalf("created mismatch: got %q", parsed.SummaryItems[0].Created)
	}
}

func TestMergeShortTermPrependsIncomingSummaryItems(t *testing.T) {
	existing := ShortTermContent{
		SummaryItems: []SummaryItem{
			{Created: "2026-02-11 09:00", Content: "The agent started a review."},
		},
	}
	draft := SessionDraft{
		SummaryItems: []string{
			"The agent discussed scope with [Alice](tg:@alice).",
			"The agent received metrics from [Bob](tg:@bob).",
		},
	}
	merged := MergeShortTerm(existing, draft, "2026-02-11 10:00")
	if len(merged.SummaryItems) != 3 {
		t.Fatalf("merged summary item count mismatch: got %d want 3", len(merged.SummaryItems))
	}
	if merged.SummaryItems[0].Created != "2026-02-11 10:00" || !strings.Contains(merged.SummaryItems[0].Content, "[Alice](tg:@alice)") {
		t.Fatalf("unexpected first merged item: %#v", merged.SummaryItems[0])
	}
}

func TestSemanticDedupeSummaryItems(t *testing.T) {
	items := []SummaryItem{
		{Created: "2026-02-11 10:00", Content: "The agent discussed the release with [Alice](tg:@alice)."},
		{Created: "2026-02-11 09:59", Content: "The agent discussed release details with [Alice](tg:@alice)."},
		{Created: "2026-02-11 09:50", Content: "The agent recorded follow-up action items."},
	}
	// keep newest + one distinct older item
	resolver := stubSummarySemanticResolver{keep: []int{0, 2}}
	out, err := SemanticDedupeSummaryItems(context.Background(), items, resolver)
	if err != nil {
		t.Fatalf("SemanticDedupeSummaryItems() error = %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("dedup count mismatch: got %d want 2", len(out))
	}
	if out[0].Created != "2026-02-11 10:00" {
		t.Fatalf("expected newest item kept first, got %#v", out[0])
	}
}

type stubSummarySemanticResolver struct {
	keep []int
	err  error
}

func (s stubSummarySemanticResolver) SelectDedupKeepIndices(_ context.Context, _ []entryutil.SemanticItem) ([]int, error) {
	if s.err != nil {
		return nil, s.err
	}
	return append([]int{}, s.keep...), nil
}
