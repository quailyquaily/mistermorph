package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// useWorkerSeeds makes newWorkerSeed return seeds in turn, the last one from then on.
func useWorkerSeeds(t *testing.T, seeds ...uint64) {
	t.Helper()
	original := newWorkerSeed
	t.Cleanup(func() { newWorkerSeed = original })
	next := 0
	newWorkerSeed = func() uint64 {
		seed := seeds[min(next, len(seeds)-1)]
		next++
		return seed
	}
}

func TestWorkerPermutation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		seed   uint64
		stream uint64
		n      int
	}{
		{"names", 42, 1, len(workerNames)},
		{"avatars", 42, 2, workerAvatarCount},
		{"one", 7, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			order := workerPermutation(tc.seed, tc.stream, tc.n)
			if !reflect.DeepEqual(order, workerPermutation(tc.seed, tc.stream, tc.n)) {
				t.Fatal("same seed gave a different order")
			}
			sorted := slices.Sorted(slices.Values(order))
			for i, v := range sorted {
				if v != i {
					t.Fatalf("not a permutation: %v", order)
				}
			}
		})
	}
	if got := workerPermutation(0, 1, 5); !reflect.DeepEqual(got, []int{0, 1, 2, 3, 4}) {
		t.Fatalf("seed 0 = %v, want the legacy order", got)
	}
	// The persisted seed must decode to the same order in every build.
	if got := workerPermutation(1, 2, workerAvatarCount); !reflect.DeepEqual(got, []int{2, 4, 3, 0, 6, 5, 1}) {
		t.Fatalf("avatar order for seed 1 = %v", got)
	}
	if reflect.DeepEqual(workerPermutation(9, 1, 7), workerPermutation(9, 2, 7)) {
		t.Fatal("names and avatars share one order")
	}
}

// allocateTaskWorkers starts n workers in one task: alternately a root coder call, a spawned
// subagent, and a coder nested inside that subagent's run.
func allocateTaskWorkers(t *testing.T, n int) []WorkerMetadata {
	t.Helper()
	ctx := llmstats.WithRunID(withWorkerScope(context.Background()), "root")
	var out []WorkerMetadata
	var child context.Context
	for i := 0; len(out) < n; i++ {
		var worker *workerState
		switch i % 3 {
		case 0:
			worker = allocateWorker(ctx, workerCallKey(ctx, fmt.Sprintf("coder-%d", i)))
		case 1:
			spawnCtx := withToolActivity(ctx, fmt.Sprintf("spawn-%d", i), "")
			_, child, _ = PrepareSubtaskContext(spawnCtx, nil)
			worker, _ = child.Value(workerContextKey{}).(*workerState)
		case 2:
			// The nested run may reuse a call ID the root already used.
			worker = allocateWorker(child, workerCallKey(child, fmt.Sprintf("coder-%d", i-2)))
		}
		out = append(out, *worker.snapshot())
	}
	return out
}

func TestWorkerAllocationIsRandomUniqueAndSharedAcrossNestedWorkers(t *testing.T) {
	const seed = 0xfeed
	useWorkerSeeds(t, seed)
	pool := len(workerNames)
	workers := allocateTaskWorkers(t, 2*pool+5)
	names := workerPermutation(seed, 1, pool)
	avatars := workerPermutation(seed, 2, workerAvatarCount)
	seen := map[string]bool{}
	for n, worker := range workers {
		if worker.ID != fmt.Sprintf("worker-%d", n+1) {
			t.Fatalf("worker %d id = %q", n, worker.ID)
		}
		if worker.NameIndex == nil || worker.AvatarIndex == nil {
			t.Fatalf("worker %d has no indices: %+v", n, worker)
		}
		round := n / pool
		if want := round*pool + names[n%pool]; *worker.NameIndex != want {
			t.Fatalf("worker %d name index = %d, want %d", n, *worker.NameIndex, want)
		}
		if want := avatars[n%workerAvatarCount]; *worker.AvatarIndex != want {
			t.Fatalf("worker %d avatar = %d, want %d", n, *worker.AvatarIndex, want)
		}
		if worker.Name != workerName(*worker.NameIndex) || seen[worker.Name] {
			t.Fatalf("worker %d name = %q (seen %v)", n, worker.Name, seen[worker.Name])
		}
		seen[worker.Name] = true
		// Plain names until the pool is used up, then the round as a suffix.
		base := workerNames[names[n%pool]]
		if round == 0 && worker.Name != base || round > 0 && worker.Name != fmt.Sprintf("%s-%d", base, round+1) {
			t.Fatalf("worker %d name = %q", n, worker.Name)
		}
	}
	// Every avatar style is used before any repeats.
	firstStyles := map[int]bool{}
	for _, worker := range workers[:workerAvatarCount] {
		firstStyles[*worker.AvatarIndex] = true
	}
	if len(firstStyles) != workerAvatarCount {
		t.Fatalf("first %d workers used %d styles", workerAvatarCount, len(firstStyles))
	}
	// Tasks do not always start with the same name or avatar.
	firstNames, firstAvatars := map[int]bool{}, map[int]bool{}
	for s := uint64(1); s <= 20; s++ {
		firstNames[workerPermutation(s, 1, pool)[0]] = true
		firstAvatars[workerPermutation(s, 2, workerAvatarCount)[0]] = true
	}
	if len(firstNames) < 5 || len(firstAvatars) < 3 {
		t.Fatalf("first picks over 20 seeds: names %v avatars %v", firstNames, firstAvatars)
	}
}

func TestWorkerAllocationIsIndependentPerTask(t *testing.T) {
	useWorkerSeeds(t, 11, 12)
	first := allocateTaskWorkers(t, 6)
	second := allocateTaskWorkers(t, 6)
	key := func(workers []WorkerMetadata) (names []string, avatars []int) {
		for _, worker := range workers {
			names = append(names, worker.Name)
			avatars = append(avatars, *worker.AvatarIndex)
		}
		return names, avatars
	}
	firstNames, firstAvatars := key(first)
	secondNames, secondAvatars := key(second)
	if reflect.DeepEqual(firstNames, secondNames) || reflect.DeepEqual(firstAvatars, secondAvatars) {
		t.Fatalf("tasks share an order: %v %v / %v %v", firstNames, firstAvatars, secondNames, secondAvatars)
	}
	if first[0].ID != "worker-1" || second[0].ID != "worker-1" {
		t.Fatal("ids depend on the seed")
	}
	// Names and avatars are drawn independently: the same name index does not imply an avatar.
	paired := true
	for i := range first {
		if *first[i].NameIndex%workerAvatarCount != *first[i].AvatarIndex {
			paired = false
		}
	}
	if paired {
		t.Fatal("avatar follows the name")
	}
	// The real source gives each task its own nonzero seed.
	a, b := newWorkerSeedDefault(), newWorkerSeedDefault()
	if a == 0 || b == 0 || a == b {
		t.Fatalf("seeds %d, %d", a, b)
	}
}

// newWorkerSeedDefault calls the seed source the package started with.
var newWorkerSeedDefault = newWorkerSeed

func TestWorkerResumeKeepsTheTaskOrder(t *testing.T) {
	const seed = 0xabc
	useWorkerSeeds(t, seed)
	uninterrupted := allocateTaskWorkers(t, 9)

	t.Run("seeded", func(t *testing.T) {
		newWorkerSeed = func() uint64 { t.Fatal("resume drew a new seed"); return 1 }
		ctx := withResumedWorkerScope(context.Background(), 4, seed)
		if allocated, gotSeed := workersAllocated(ctx); allocated != 4 || gotSeed != seed {
			t.Fatalf("allocated %d seed %d", allocated, gotSeed)
		}
		for n := 4; n < 9; n++ {
			got := allocateWorker(ctx, fmt.Sprintf("after-%d", n)).snapshot()
			if !reflect.DeepEqual(*got, uninterrupted[n]) {
				t.Fatalf("worker %d after resume = %+v, want %+v", n, got, uninterrupted[n])
			}
		}
	})
	t.Run("legacy state without a seed", func(t *testing.T) {
		newWorkerSeed = func() uint64 { t.Fatal("legacy resume drew a new seed"); return 1 }
		ctx := withResumedWorkerScope(context.Background(), 3, 0)
		got := allocateWorker(ctx, "after").snapshot()
		if got.ID != "worker-4" || got.Name != "Cleo" || *got.NameIndex != 3 || *got.AvatarIndex != 3 {
			t.Fatalf("legacy continuation = %+v", got)
		}
	})
	t.Run("nothing allocated before the pause", func(t *testing.T) {
		useWorkerSeeds(t, 77)
		ctx := withResumedWorkerScope(context.Background(), 0, 0)
		if _, gotSeed := workersAllocated(ctx); gotSeed != 77 {
			t.Fatalf("seed = %d", gotSeed)
		}
	})
	t.Run("an existing scope adopts the seed before its first worker", func(t *testing.T) {
		useWorkerSeeds(t, 5)
		ctx := withResumedWorkerScope(withWorkerScope(context.Background()), 2, seed)
		if _, gotSeed := workersAllocated(ctx); gotSeed != seed {
			t.Fatalf("seed = %d", gotSeed)
		}
	})
}

func TestWorkerMetadataJSON(t *testing.T) {
	zero := 0
	raw, err := json.Marshal(WorkerMetadata{ID: "worker-1", Name: "Milo", NameIndex: &zero, AvatarIndex: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"id":"worker-1","name":"Milo","name_index":0,"avatar_index":0}` {
		t.Fatalf("json = %s", raw)
	}
	var legacy WorkerMetadata
	if err := json.Unmarshal([]byte(`{"id":"worker-2","name":"Luna"}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.NameIndex != nil || legacy.AvatarIndex != nil || legacy.ID != "worker-2" || legacy.Name != "Luna" {
		t.Fatalf("legacy = %+v", legacy)
	}
	var rs resumeState
	if err := json.Unmarshal([]byte(`{"workers_allocated":2}`), &rs); err != nil || rs.WorkerSeed != 0 || rs.WorkersAllocated != 2 {
		t.Fatalf("legacy resume state = %+v, %v", rs, err)
	}
	rs.WorkerSeed = 1<<64 - 1
	raw, _ = json.Marshal(rs)
	var loaded resumeState
	if err := json.Unmarshal(raw, &loaded); err != nil || loaded.WorkerSeed != rs.WorkerSeed {
		t.Fatalf("seed round trip = %d, %v", loaded.WorkerSeed, err)
	}
}

// The Console renders the names and avatars from its own copy of the pools; they must agree.
func TestWorkerPoolsMatchConsole(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "web", "console-nsh", "lib", "core", "worker-identity.js"))
	if err != nil {
		t.Fatal(err)
	}
	quoted := regexp.MustCompile(`"([^"]+)"`)
	pool := func(lang string) []string {
		block := regexp.MustCompile(`(?s)\n  ` + lang + `: Object\.freeze\(\[(.*?)\]\)`).FindSubmatch(source)
		if block == nil {
			t.Fatalf("no %s pool", lang)
		}
		var names []string
		for _, match := range quoted.FindAllSubmatch(block[1], -1) {
			names = append(names, string(match[1]))
		}
		return names
	}
	if got := pool("en"); !slices.Equal(got, workerNames[:]) {
		t.Fatalf("console English pool = %v", got)
	}
	for _, lang := range []string{"zh", "ja"} {
		if got := pool(lang); len(got) != len(workerNames) {
			t.Fatalf("%s pool has %d names", lang, len(got))
		}
	}
	styles := regexp.MustCompile(`WORKER_AVATAR_STYLES = Object\.freeze\(\[([^\]]*)\]\)`).FindSubmatch(source)
	if styles == nil || len(quoted.FindAll(styles[1], -1)) != workerAvatarCount {
		t.Fatalf("console avatar styles: %q", styles)
	}
	assets, err := filepath.Glob(filepath.Join("..", "web", "console-nsh", "assets", "worker-avatars", "*.svg"))
	if err != nil || len(assets) != workerAvatarCount {
		t.Fatalf("avatar assets = %v, %v", assets, err)
	}
	for _, asset := range assets {
		if !strings.Contains(string(styles[1]), `"`+strings.TrimSuffix(filepath.Base(asset), ".svg")+`"`) {
			t.Fatalf("asset %s is not a style", asset)
		}
	}
}
