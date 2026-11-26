package daemonruntime

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func soloIndex(n int) *int { return &n }

func soloWorkers(from, to int, status string) []SoloParticipant {
	var out []SoloParticipant
	for n := from; n <= to; n++ {
		out = append(out, SoloParticipant{ID: fmt.Sprintf("worker-%d", n), Name: fmt.Sprintf("W%d", n), Kind: SoloParticipantSubagent, Status: status})
	}
	return out
}

func soloIDs(list []SoloParticipant) string {
	ids := make([]string, 0, len(list))
	for _, p := range list {
		ids = append(ids, strings.TrimPrefix(p.ID, "worker-"))
	}
	return strings.Join(ids, ",")
}

func TestNormalizeSoloParticipants(t *testing.T) {
	got, cut := NormalizeSoloParticipants([]SoloParticipant{
		{ID: " worker-1 ", Name: " Ada ", NameSet: "scientists", NameIndex: soloIndex(3), AvatarIndex: soloIndex(5), Kind: "coder", Status: " Running "},
		{ID: "", Name: "nobody"},
		{ID: "worker-2", Name: "Milo", Kind: "something else", NameIndex: soloIndex(-1)},
		// The same worker again updates it: one worker, its latest status, its identity kept.
		{ID: "worker-1", Status: "failed"},
	})
	want := []SoloParticipant{
		{ID: "worker-1", Name: "Ada", NameSet: "scientists", NameIndex: soloIndex(3), AvatarIndex: soloIndex(5), Kind: SoloParticipantCoder, Status: "failed"},
		{ID: "worker-2", Name: "Milo", Kind: SoloParticipantSubagent},
	}
	if cut != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("participants = %+v (cut %d), want %+v", got, cut, want)
	}
	if !SoloParticipantsEqual(got, want) || SoloParticipantsEqual(got, want[:1]) {
		t.Fatal("SoloParticipantsEqual disagrees with DeepEqual")
	}
	changed := append([]SoloParticipant(nil), want...)
	changed[0].Status = "done"
	if SoloParticipantsEqual(got, changed) {
		t.Fatal("a changed status reads as equal")
	}
	if got, cut := NormalizeSoloParticipants(nil); got != nil || cut != 0 {
		t.Fatalf("no workers = %+v, %d", got, cut)
	}
	// More than the limit: the newest stay, the cut ones are counted.
	got, cut = NormalizeSoloParticipants(soloWorkers(1, SoloParticipantLimit+5, "done"))
	if len(got) != SoloParticipantLimit || cut != 5 || got[0].ID != "worker-6" {
		t.Fatalf("bounded = %d workers from %s, cut %d", len(got), got[0].ID, cut)
	}
}

// A card follows its task's activity, which itself lists only its newest workers: however the
// readings arrive, each worker is listed once and the omitted count never counts one twice.
func TestMergeSoloParticipantsFollowsABoundedRoster(t *testing.T) {
	var card []SoloParticipant
	omitted := 0
	// One run, 40 workers one after another; the activity keeps its newest 32.
	for n := 1; n <= 40; n++ {
		from := max(1, n-SoloParticipantLimit+1)
		for i := 0; i < 2; i++ { // every reading arrives twice
			card, omitted = MergeSoloParticipants(card, omitted, soloWorkers(from, n, "running"), from-1)
		}
	}
	if len(card) != SoloParticipantLimit || omitted != 8 || card[0].ID != "worker-9" || card[len(card)-1].ID != "worker-40" {
		t.Fatalf("card = %s, omitted %d", soloIDs(card), omitted)
	}

	// A task resumed after a pause reports only the workers of its new run: the earlier ones stay.
	card, omitted = soloWorkers(1, 3, "done"), 0
	card, omitted = MergeSoloParticipants(card, omitted, soloWorkers(4, 5, "running"), 0)
	if soloIDs(card) != "1,2,3,4,5" || omitted != 0 || card[0].Status != "done" || card[4].Status != "running" {
		t.Fatalf("resumed card = %+v, omitted %d", card, omitted)
	}
	// And when that run outgrows the limit, the earlier workers are the ones dropped and counted.
	for n := 6; n <= 3+SoloParticipantLimit+2; n++ {
		from := max(4, n-SoloParticipantLimit+1)
		card, omitted = MergeSoloParticipants(card, omitted, soloWorkers(from, n, "running"), from-4)
	}
	if len(card) != SoloParticipantLimit || omitted != 5 || card[0].ID != "worker-6" {
		t.Fatalf("resumed long card = %s, omitted %d", soloIDs(card), omitted)
	}

	// A card that kept nothing (written before participants were) takes the task's own count.
	card, omitted = MergeSoloParticipants(nil, 0, soloWorkers(6, 37, "done"), 5)
	if len(card) != SoloParticipantLimit || omitted != 5 {
		t.Fatalf("caught-up card = %d workers, omitted %d", len(card), omitted)
	}
	// An empty reading takes nothing away.
	again, againOmitted := MergeSoloParticipants(card, omitted, nil, 0)
	if !SoloParticipantsEqual(again, card) || againOmitted != omitted {
		t.Fatalf("empty reading changed the card: %s, %d", soloIDs(again), againOmitted)
	}
}

func TestEndSoloParticipants(t *testing.T) {
	list := []SoloParticipant{
		{ID: "worker-1", Kind: SoloParticipantSubagent, Status: "running"},
		{ID: "worker-2", Kind: SoloParticipantCoder, Status: "failed"},
		{ID: "worker-3", Kind: SoloParticipantSubagent, Status: "done"},
		{ID: "worker-4", Kind: SoloParticipantSubagent},
	}
	for state, want := range map[string]string{
		SoloThreadDone:     "done,failed,done,done",
		SoloThreadFailed:   "failed,failed,done,failed",
		SoloThreadCanceled: "canceled,failed,done,canceled",
		SoloThreadRunning:  "running,failed,done,",
		SoloThreadWaiting:  "running,failed,done,",
	} {
		var got []string
		for _, p := range EndSoloParticipants(list, state) {
			got = append(got, p.Status)
		}
		if strings.Join(got, ",") != want {
			t.Errorf("ended %s: %v, want %s", state, got, want)
		}
	}
	if list[0].Status != "running" {
		t.Fatal("EndSoloParticipants changed its input")
	}
}

// A participant names a worker and nothing else, and a record without participants reads and
// writes as it did before they were kept.
func TestSoloThreadParticipantJSON(t *testing.T) {
	raw, err := json.Marshal(SoloParticipant{ID: "worker-1", Name: "Ada", NameSet: "scientists", NameIndex: soloIndex(0), AvatarIndex: soloIndex(2), Kind: SoloParticipantCoder, Status: "done"})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"id": true, "name": true, "name_set": true, "name_index": true, "avatar_index": true, "kind": true, "status": true}
	if len(fields) != len(allowed) {
		t.Fatalf("fields = %s", raw)
	}
	for key := range fields {
		if !allowed[key] {
			t.Fatalf("participant carries %q: %s", key, raw)
		}
	}
	// A worker of the activity loses everything but its identity when read as a participant.
	var p SoloParticipant
	worker := `{"id":"worker-1","name":"Ada","kind":"coder","status":"running","task":"secret ask","output":"secret out","result":"secret result","error":"secret err","processes":[{"pid":4242,"program":"codex"}],"messages":[{"text":"secret msg"}]}`
	if err := json.Unmarshal([]byte(worker), &p); err != nil {
		t.Fatal(err)
	}
	again, _ := json.Marshal(p)
	if strings.Contains(string(again), "secret") || strings.Contains(string(again), "4242") {
		t.Fatalf("participant kept more than an identity: %s", again)
	}

	old := `{"kind":"card","topic_id":"t1","task_id":"k1","title":"Build","state":"done"}`
	var rec SoloThread
	if err := json.Unmarshal([]byte(old), &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Participants != nil || rec.ParticipantsOmitted != 0 {
		t.Fatalf("old record = %+v", rec)
	}
	if back, _ := json.Marshal(rec); string(back) != old {
		t.Fatalf("old record written back as %s", back)
	}
}
