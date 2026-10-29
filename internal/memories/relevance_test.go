package memories

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/audience"
)

func TestTerms(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
		want []string
	}{
		{"words are lowercased, folded and stopwords dropped", "Please send the Release Notes", []string{"send", "releas", "not"}},
		{"suffixes fold to the same stem", "releasing released releases", []string{"releas", "releas", "releas"}},
		{"identifiers stay whole too", "tag v0.3.66 for @alice", []string{"tag", "v0.3.66*", "v0", "66", "@alice*", "alic"}},
		{"a trailing period is not an identifier", "shipped.", []string{"shipp"}},
		{"plurals fold before -ing", "meetings meeting meet", []string{"meet", "meet", "meet"}},
		{"Chinese becomes character pairs", "发布说明", []string{"发布", "布说", "说明"}},
		{"common Chinese pairs are dropped", "帮我发布", []string{"我发", "发布"}},
		{"katakana keeps its long vowel mark", "リリースノート", []string{"リリ", "リー", "ース", "スノ", "ノー", "ート"}},
		{"pairs stop at a change of script and hiragana gives nothing", "メールは議事録を", []string{"メー", "ール", "議事", "事録"}},
		{"a lone kanji between kana is a term", "電車が遅れている", []string{"電車", "遅"}},
		{"CamelCase names stay whole", "TestJournalImport failed", []string{"testjournalimport*", "testjournalimport", "fail"}},
		{"a single CJK character says too little", "猫", nil},
		{"mixed scripts split at the boundary", "用Go写", []string{"go"}},
		{"punctuation around words is dropped", "(deadline: Friday!)", []string{"deadlin", "friday"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, term := range terms(tc.text) {
				if term.whole {
					got = append(got, term.text+"*")
				} else {
					got = append(got, term.text)
				}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("terms(%q) = %q, want %q", tc.text, got, tc.want)
			}
		})
	}
}

func TestQueryText(t *testing.T) {
	got := QueryText(
		`{"current_message":{"sender":{"username":"alice","display_ref":"[Alice](tg:@alice)"},"text":"ship it","quote":{"text":"the v2 build"}},"instruction":"Respond now."}`,
		`{"type":"final","output":"Tagged v1."}`,
		"plain words",
		"   ",
	)
	if got != "the v2 build\nship it\nTagged v1.\nplain words" {
		t.Fatalf("QueryText() = %q", got)
	}
	long := strings.Repeat("字", queryRunes+10)
	if got := QueryText(long, "dropped"); len([]rune(got)) != queryRunes {
		t.Fatalf("query of %d runes, want it cut at %d", len([]rune(got)), queryRunes)
	}
}

// relevanceBench is a made-up store and the messages a run might start from
// (testdata/relevance_bench.json). The memories come in the shapes the memory rules ask for, in
// English, Chinese and Japanese, with near neighbors on purpose (three about release notes, four
// about Alice, coffee and green tea) so that precision is tested, not just recall. Each case lists
// the memories it must find (want) and those it may find without being wrong (ok). A case with no
// want is about nothing in the store. A cross case asks in one language about a memory written in
// another, where words cannot match; those are counted apart.
type relevanceBench struct {
	Memories []struct {
		ID          string `json:"id"`
		Subject     string `json:"subject"`
		Name        string `json:"name"`
		Type        Type   `json:"type"`
		Description string `json:"description"`
		Body        string `json:"body"`
		ToldBy      string `json:"told_by"`
	} `json:"memories"`
	Cases []struct {
		Query string   `json:"q"`
		Lang  string   `json:"lang"`
		Cross bool     `json:"cross"`
		Want  []string `json:"want"`
		OK    []string `json:"ok"`
	} `json:"cases"`
}

// benchTally adds up one group of cases.
type benchTally struct {
	cases, wanted, hits, found, fine, complete, withWant, empty, clean int
	reciprocal                                                         float64
}

func (b benchTally) recall() float64    { return ratio(b.hits, b.wanted) }
func (b benchTally) precision() float64 { return ratio(b.fine, b.found) }

func ratio(a, b int) float64 {
	if b == 0 {
		return 1
	}
	return float64(a) / float64(b)
}

// TestRelevanceBench scores Rank on the bench and logs, per group: recall (wanted memories found),
// precision (found memories that were wanted or fine), complete (cases that found everything they
// wanted), MRR (one over the rank of the first wanted memory) and, for messages about nothing, how
// many found nothing. Run it with -v to see the table and every miss. The floors keep a change from
// quietly making it worse; raise them as it gets better.
func TestRelevanceBench(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "relevance_bench.json"))
	if err != nil {
		t.Fatal(err)
	}
	var bench relevanceBench
	if err := json.Unmarshal(raw, &bench); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	items := make([]Memory, len(bench.Memories))
	for i, m := range bench.Memories {
		items[i] = Memory{ID: m.ID, Subject: m.Subject, Name: m.Name, Type: m.Type, Description: m.Description, Body: m.Body, ToldBy: m.ToldBy,
			UpdatedAt: now.Add(-time.Duration(i*37%300) * 24 * time.Hour).Format(time.RFC3339)}
	}
	groups := map[string]*benchTally{}
	group := func(name string) *benchTally {
		if groups[name] == nil {
			groups[name] = &benchTally{}
		}
		return groups[name]
	}
	for _, tc := range bench.Cases {
		ranked := Rank(items, tc.Query, RankOptions{Now: now})
		want, fine := map[string]bool{}, map[string]bool{}
		for _, id := range tc.Want {
			want[id], fine[id] = true, true
		}
		for _, id := range tc.OK {
			fine[id] = true
		}
		var got []string
		hits, fineHits, firstRank := 0, 0, 0
		for i, r := range ranked {
			got = append(got, r.Memory.ID)
			if want[r.Memory.ID] {
				hits++
				if firstRank == 0 {
					firstRank = i + 1
				}
			}
			if fine[r.Memory.ID] {
				fineHits++
			}
		}
		names := []string{tc.Lang, "all"}
		switch {
		case tc.Cross:
			names = []string{"cross"}
		case len(tc.Want) == 0:
			names = []string{"unrelated"}
		}
		for _, name := range names {
			g := group(name)
			g.cases++
			g.wanted += len(tc.Want)
			g.hits += hits
			g.found += len(got)
			g.fine += fineHits
			if len(tc.Want) > 0 {
				g.withWant++
				if hits == len(tc.Want) {
					g.complete++
				}
				if firstRank > 0 {
					g.reciprocal += 1 / float64(firstRank)
				}
			} else {
				g.empty++
				if len(got) == 0 {
					g.clean++
				}
			}
		}
		if hits < len(tc.Want) || fineHits < len(got) {
			t.Logf("%-8s %q: found %v, want %v", names[0], tc.Query, got, tc.Want)
		}
	}
	t.Logf("%-9s %5s %7s %9s %9s %6s %s", "group", "cases", "recall", "precision", "complete", "MRR", "unrelated found nothing")
	for _, name := range []string{"en", "zh", "ja", "all", "unrelated", "cross"} {
		g := groups[name]
		if g == nil {
			continue
		}
		t.Logf("%-9s %5d %7.2f %9.2f %9.2f %6.2f %d/%d", name, g.cases, g.recall(), g.precision(), ratio(g.complete, g.withWant),
			g.reciprocal/math.Max(float64(g.withWant), 1), g.clean, g.empty)
	}
	all, unrelated := groups["all"], groups["unrelated"]
	if r := all.recall(); r < benchRecallFloor {
		t.Errorf("recall %.2f, want at least %.2f", r, benchRecallFloor)
	}
	if p := all.precision(); p < benchPrecisionFloor {
		t.Errorf("precision %.2f, want at least %.2f", p, benchPrecisionFloor)
	}
	if c := ratio(unrelated.clean, unrelated.empty); c < benchCleanFloor {
		t.Errorf("found memories for %d of %d unrelated messages", unrelated.empty-unrelated.clean, unrelated.empty)
	}
}

const (
	benchRecallFloor    = 0.8
	benchPrecisionFloor = 0.9
	benchCleanFloor     = 1.0
)

func TestRankFavorsSubjectsAndKeepsTheLimit(t *testing.T) {
	items := []Memory{
		{ID: "general", Subject: "general", Name: "timezone", Description: "Team timezone notes", Body: "timezone notes"},
		{ID: "speaker", Subject: "contact:tg:@alice", Name: "timezone", Description: "Team timezone notes", Body: "timezone notes"},
	}
	ranked := Rank(items, "timezone notes", RankOptions{Subjects: []string{"contact:tg:@alice"}})
	if len(ranked) != 2 || ranked[0].Memory.ID != "speaker" {
		t.Fatalf("ranked = %+v, want the speaker's memory first", ranked)
	}
	var many []Memory
	for i := 0; i < 20; i++ {
		many = append(many, Memory{ID: fmt.Sprint(i), Subject: "owner", Name: "deploy", Description: "deploy checklist", Body: "deploy checklist"})
	}
	if got := Rank(many, "deploy checklist", RankOptions{Limit: 5}); len(got) != 5 {
		t.Fatalf("%d matches, want the limit of 5", len(got))
	}
}

func TestPickRunMemories(t *testing.T) {
	all := []Memory{
		{ID: "new-context", Type: TypeContext},
		{ID: "new-feedback", Type: TypeFeedback},
		{ID: "match", Type: TypeReference},
		{ID: "old-feedback", Type: TypeFeedback},
		{ID: "old-person", Type: TypePerson},
	}
	ranked := []Ranked{{Memory: all[2]}}
	for _, tc := range []struct {
		limit int
		want  []string
		more  bool
	}{
		{10, []string{"match", "new-feedback", "old-feedback", "new-context", "old-person"}, false},
		{3, []string{"match", "new-feedback", "old-feedback"}, true},
	} {
		t.Run(fmt.Sprint(tc.limit), func(t *testing.T) {
			got := pickRunMemories(all, ranked, tc.limit)
			var ids []string
			for _, m := range got.Items {
				ids = append(ids, m.ID)
			}
			if !reflect.DeepEqual(ids, tc.want) || got.More != tc.more || !got.Relevant["match"] || len(got.Relevant) != 1 {
				t.Fatalf("picked %v (more %v, relevant %v), want %v (more %v)", ids, got.More, got.Relevant, tc.want, tc.more)
			}
		})
	}
}

func TestForRunFindsAnOldMemoryTheMessageIsAbout(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "memory.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { clock = clock.Add(time.Hour); return clock }
	save := func(name, description string) {
		t.Helper()
		if _, err := store.Save(ctx, audience.Owner(), Draft{Subject: "owner", Name: name, Type: TypeContext, Description: description, Body: description}); err != nil {
			t.Fatal(err)
		}
	}
	save("vet-appointment", "The cat sees the vet on 2026-02-03")
	for i := 0; i < 5; i++ {
		save(fmt.Sprintf("note-%d", i), fmt.Sprintf("Unrelated note %d", i))
	}
	got, err := store.ForRun(ctx, audience.Owner(), nil, "when is the cat's vet appointment?", 3)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, m := range got.Items {
		ids = append(ids, m.Name)
	}
	sort.Strings(ids[1:])
	if len(ids) != 3 || ids[0] != "vet-appointment" || !got.More || len(got.Relevant) != 1 {
		t.Fatalf("picked %v (more %v, relevant %v), want the oldest memory first because the message is about it", ids, got.More, got.Relevant)
	}
	if got, _ := store.ForRun(ctx, audience.Conversation("tg:-1"), nil, "vet appointment", 3); len(got.Items) != 0 {
		t.Fatalf("a group heard the owner's memories: %+v", got.Items)
	}
}
