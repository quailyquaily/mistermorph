package domainjournal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestJournalAppendAndReplay(t *testing.T) {
	j := openTestJournal(t, t.TempDir())

	if _, err := j.Append(baseEvent("evt_1", "audit", "record")); err != nil {
		t.Fatalf("Append(evt_1) error = %v", err)
	}
	cursor, err := j.Append(baseEvent("evt_2", "task", "task_upsert"))
	if err != nil {
		t.Fatalf("Append(evt_2) error = %v", err)
	}
	if cursor.Seq != 2 {
		t.Fatalf("Append(evt_2) cursor = %#v, want seq 2", cursor)
	}

	if got, want := replayIDs(t, j, Cursor{}), "evt_1@1,evt_2@2"; got != want {
		t.Fatalf("Replay() = %q, want %q", got, want)
	}
}

func TestJournalReplayKeepsEnvelope(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	event := baseEvent("evt_full", "task", "task_update")
	event.Audience = "contact:tg:42"
	if _, err := j.Append(event); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	var got Event
	if err := j.Replay(func(rec Record) error {
		got = rec.Event
		return nil
	}); err != nil {
		t.Fatalf("Replay() error = %v", err)
	}
	if got.ID != event.ID || got.Time != event.Time || got.Domain != event.Domain || got.Type != event.Type ||
		got.SchemaVersion != event.SchemaVersion || got.Trace != event.Trace || got.Audience != event.Audience ||
		string(got.Payload) != string(event.Payload) {
		t.Fatalf("Replay() event = %#v, want %#v", got, event)
	}
}

func TestJournalReplayFromCursor(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	var middle Cursor
	for i := 1; i <= 3; i++ {
		cursor, err := j.Append(baseEvent(fmt.Sprintf("evt_%d", i), "audit", "record"))
		if err != nil {
			t.Fatalf("Append(%d) error = %v", i, err)
		}
		if i == 2 {
			middle = cursor
		}
	}
	if got, want := replayIDs(t, j, middle), "evt_3@3"; got != want {
		t.Fatalf("ReplayFrom(seq 2) = %q, want %q", got, want)
	}
}

func TestJournalReplayCrossesBatches(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	total := replayBatchSize + 7
	for i := 1; i <= total; i++ {
		if _, err := j.Append(baseEvent(fmt.Sprintf("evt_%d", i), "audit", "record")); err != nil {
			t.Fatalf("Append(%d) error = %v", i, err)
		}
	}
	count := 0
	var last int64
	if err := j.Replay(func(rec Record) error {
		count++
		if rec.Ref.Seq != last+1 {
			return fmt.Errorf("seq %d after %d", rec.Ref.Seq, last)
		}
		last = rec.Ref.Seq
		return nil
	}); err != nil {
		t.Fatalf("Replay() error = %v", err)
	}
	if count != total {
		t.Fatalf("Replay() count = %d, want %d", count, total)
	}
}

func TestJournalReplayRejectsSegmentCursor(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	err := j.ReplayFrom(Cursor{File: "events.000000000000000001.jsonl", Line: 3}, func(Record) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "replay from the start") {
		t.Fatalf("ReplayFrom(segment cursor) error = %v, want replay-from-start error", err)
	}
}

func TestAppendRejectsInvalidEnvelope(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	for name, mutate := range map[string]func(*Event){
		"missing id":      func(e *Event) { e.ID = "" },
		"padded domain":   func(e *Event) { e.Domain = " task" },
		"bad time":        func(e *Event) { e.Time = "yesterday" },
		"schema version":  func(e *Event) { e.SchemaVersion = 0 },
		"invalid payload": func(e *Event) { e.Payload = json.RawMessage(`{`) },
	} {
		t.Run(name, func(t *testing.T) {
			event := baseEvent("evt_bad", "task", "task_upsert")
			mutate(&event)
			if _, err := j.Append(event); err == nil {
				t.Fatalf("Append() error = nil, want validation error")
			}
		})
	}
}

func TestJournalIndexReturnsLastEventsOldestFirst(t *testing.T) {
	root := t.TempDir()
	j := openTestJournal(t, root)
	for i := 1; i <= 4; i++ {
		event := baseEvent(fmt.Sprintf("evt_%d", i), "task", "task_update")
		if i == 3 {
			event.Trace.TaskID = "task_other"
			event.Trace.TopicID = ""
		}
		if _, err := j.Append(event); err != nil {
			t.Fatalf("Append(%d) error = %v", i, err)
		}
	}
	_ = j.Close()

	index, err := ReadIndexDir(root, "task", "task_1", 2)
	if err != nil {
		t.Fatalf("ReadIndexDir() error = %v", err)
	}
	if len(index) != 2 || index[0].Ref.Seq != 2 || index[1].Ref.Seq != 4 || index[0].Key != "task_1" {
		t.Fatalf("ReadIndexDir(task_1, 2) = %#v, want seqs 2 and 4", index)
	}
	topic, err := ReadIndexDir(root, "topic", "topic_1", 10)
	if err != nil || len(topic) != 3 {
		t.Fatalf("ReadIndexDir(topic_1) = %#v, %v; want 3 records", topic, err)
	}
	record, err := ReadAtDir(root, index[1].Ref)
	if err != nil {
		t.Fatalf("ReadAtDir() error = %v", err)
	}
	if record.Event.ID != "evt_4" {
		t.Fatalf("ReadAtDir() id = %q, want evt_4", record.Event.ID)
	}
	if _, err := ReadAtDir(root, RecordRef{Seq: 99}); err == nil {
		t.Fatal("ReadAtDir(missing) error = nil, want not found")
	}
	if _, err := ReadIndexDir(root, "nope", "x", 1); err == nil {
		t.Fatal("ReadIndexDir(bad kind) error = nil, want error")
	}
}

func TestDirReadersOnMissingDirCreateNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	if err := ReplayDir(dir, func(Record) error { return fmt.Errorf("unexpected record") }); err != nil {
		t.Fatalf("ReplayDir(missing) error = %v", err)
	}
	if index, err := ReadIndexDir(dir, "task", "task_1", 10); err != nil || len(index) != 0 {
		t.Fatalf("ReadIndexDir(missing) = %#v, %v; want empty", index, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("missing dir was created: %v", err)
	}
}

func TestJournalSurvivesReopenAndClose(t *testing.T) {
	root := t.TempDir()
	j := openTestJournal(t, root)
	if _, err := j.Append(baseEvent("evt_1", "audit", "record")); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	if err := j.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := j.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
	if _, err := j.Append(baseEvent("evt_2", "audit", "record")); err == nil {
		t.Fatal("Append() after Close error = nil")
	}
	if got, want := replayIDs(t, j, Cursor{}), "evt_1@1"; got != want {
		t.Fatalf("Replay() after Close = %q, want %q: a closed journal stays readable", got, want)
	}
	reopened := openTestJournal(t, root)
	if got, want := replayIDs(t, reopened, Cursor{}), "evt_1@1"; got != want {
		t.Fatalf("Replay() after reopen = %q, want %q", got, want)
	}
}

func TestJournalImportsSegmentsOnce(t *testing.T) {
	root := t.TempDir()
	writeSegment(t, root, 2, eventLine(t, baseEvent("evt_3", "audit", "record")))
	writeSegment(t, root, 1,
		eventLine(t, baseEvent("evt_1", "audit", "record"))+
			"\n"+
			`{"id":"evt_2","time":"2026-06-15T01:02:03Z","domain":"task","type":"task_upsert","schema_version":1,"future_field":true,"payload":{"value":"evt_2"}}`+"\n"+
			"{bad json}\n")

	j := openTestJournal(t, root)
	if got, want := replayIDs(t, j, Cursor{}), "evt_1@1,evt_2@2,evt_3@3"; got != want {
		t.Fatalf("Replay() after import = %q, want %q", got, want)
	}
	var rejected int
	var rejectedRaw string
	if err := j.db.QueryRow(`SELECT count(*), max(raw) FROM journal_import_rejects WHERE file = 'events.000000000000000001.jsonl' AND line = 4`).Scan(&rejected, &rejectedRaw); err != nil {
		t.Fatalf("read rejects: %v", err)
	}
	if rejected != 1 || rejectedRaw != "{bad json}" {
		t.Fatalf("rejects = %d %q, want the bad line kept", rejected, rejectedRaw)
	}
	_ = j.Close()

	// A segment written after the import, for example by an older binary, is not imported again.
	writeSegment(t, root, 3, eventLine(t, baseEvent("evt_4", "audit", "record")))
	reopened := openTestJournal(t, root)
	if got, want := replayIDs(t, reopened, Cursor{}), "evt_1@1,evt_2@2,evt_3@3"; got != want {
		t.Fatalf("Replay() after reopen = %q, want %q (import ran twice)", got, want)
	}
	if _, err := os.Stat(filepath.Join(root, segmentName(1))); err != nil {
		t.Fatalf("segment removed after import: %v", err)
	}
}

func TestJournalImportWithConcurrentOpens(t *testing.T) {
	root := t.TempDir()
	var lines strings.Builder
	for i := 1; i <= 200; i++ {
		lines.WriteString(eventLine(t, baseEvent(fmt.Sprintf("evt_%d", i), "audit", "record")))
	}
	writeSegment(t, root, 1, lines.String())

	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j, err := New(JournalOptions{Dir: root})
			if err != nil {
				errs <- err
				return
			}
			errs <- j.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent New() error = %v", err)
		}
	}
	j := openTestJournal(t, root)
	count := 0
	if err := j.Replay(func(Record) error { count++; return nil }); err != nil {
		t.Fatalf("Replay() error = %v", err)
	}
	if count != 200 {
		t.Fatalf("events = %d, want 200 (import ran more than once or partly)", count)
	}
}

func TestJournalCompressesPayload(t *testing.T) {
	j := openTestJournal(t, t.TempDir())
	event := baseEvent("evt_big", "task", "task_update")
	event.Payload = json.RawMessage(`{"trace":"` + strings.Repeat("tool output ", 2000) + `"}`)
	if _, err := j.Append(event); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	var stored int
	if err := j.db.QueryRow(`SELECT length(payload) FROM journal_events WHERE seq = 1`).Scan(&stored); err != nil {
		t.Fatalf("read payload size: %v", err)
	}
	if stored >= len(event.Payload)/10 {
		t.Fatalf("stored payload = %d bytes for %d bytes of JSON, want it compressed", stored, len(event.Payload))
	}
	record, err := j.ReadAt(RecordRef{Seq: 1})
	if err != nil || string(record.Event.Payload) != string(event.Payload) {
		t.Fatalf("ReadAt() payload round trip failed: %v", err)
	}
}

func TestJournalDurableSetting(t *testing.T) {
	for _, tc := range []struct {
		sync bool
		want int
	}{{false, 1}, {true, 2}} {
		j, err := New(JournalOptions{Dir: t.TempDir(), SyncEachWrite: tc.sync})
		if err != nil {
			t.Fatalf("New() error = %v", err)
		}
		var got int
		if err := j.db.QueryRow(`PRAGMA synchronous`).Scan(&got); err != nil || got != tc.want {
			t.Fatalf("SyncEachWrite=%v synchronous = %d, %v; want %d", tc.sync, got, err, tc.want)
		}
		_ = j.Close()
	}
}

func openTestJournal(t *testing.T, dir string) *Journal {
	t.Helper()
	j, err := New(JournalOptions{Dir: dir})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = j.Close() })
	return j
}

func replayIDs(t *testing.T, j *Journal, from Cursor) string {
	t.Helper()
	var got []string
	if err := j.ReplayFrom(from, func(rec Record) error {
		if rec.Cursor.Seq != rec.Ref.Seq {
			return fmt.Errorf("cursor %d != ref %d", rec.Cursor.Seq, rec.Ref.Seq)
		}
		got = append(got, fmt.Sprintf("%s@%d", rec.Event.ID, rec.Ref.Seq))
		return nil
	}); err != nil {
		t.Fatalf("ReplayFrom() error = %v", err)
	}
	return strings.Join(got, ",")
}

func segmentName(index int64) string {
	return fmt.Sprintf("%s%018d%s", segmentPrefix, index, segmentSuffix)
}

func writeSegment(t *testing.T, dir string, index int64, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, segmentName(index)), []byte(content), 0o600); err != nil {
		t.Fatalf("write segment: %v", err)
	}
}

func eventLine(t *testing.T, event Event) string {
	t.Helper()
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	return string(raw) + "\n"
}

func baseEvent(id, domain, typ string) Event {
	return Event{
		ID:            id,
		Time:          "2026-06-15T01:02:03Z",
		Domain:        domain,
		Type:          typ,
		SchemaVersion: 1,
		Trace: Trace{
			TraceID: "tr_" + id,
			Runtime: "console",
			Target:  "console",
			TopicID: "topic_1",
			TaskID:  "task_1",
		},
		Payload: json.RawMessage(`{"value":"` + id + `"}`),
	}
}
