import assert from "node:assert/strict";
import test from "node:test";
import { filterLogEntries, logClock, logDayKey, logDayLabel, logFieldPreview, logSnapshotKey, parseLogLine } from "./logs.js";

test("structured logs retain detail fields and normalize warning levels", () => {
  const line = JSON.stringify({ time: "2026-09-21T04:00:00Z", level: "WARNING", msg: "request failed", retry: 0, context: { host: "api.example.com" } });
  const entry = parseLogLine(line);
  assert.equal(entry.level, "warn");
  assert.equal(entry.msg, "request failed");
  assert.equal(entry.line, line);
  assert.deepEqual(entry.fields, [["retry", "0"], ["context", '{\n  "host": "api.example.com"\n}']]);
});

test("plain text, malformed JSON, and non-object JSON remain readable without an invented level", () => {
  for (const line of ["socket closed", "{invalid", "null", "42", '["message"]']) {
    const entry = parseLogLine(line);
    assert.equal(entry.msg, line);
    assert.equal(entry.level, "");
    assert.deepEqual(entry.fields, []);
  }
  assert.equal(parseLogLine('{"error":"timeout"}').msg, '{"error":"timeout"}');
});

test("search includes detail fields, combines with level, and preserves repeated lines", () => {
  const warning = parseLogLine('{"level":"WARN","msg":"retrying","task_id":"TASK_A"}');
  const info = parseLogLine('{"level":"INFO","msg":"done","task_id":"task_a"}');
  assert.deepEqual(filterLogEntries([warning, info, warning], " task_A ", "warn"), [warning, warning]);
  assert.deepEqual(filterLogEntries([warning, info], "missing", ""), []);
  assert.deepEqual(filterLogEntries([warning, info], "", ""), [warning, info]);
});

test("refresh detects appended, rotated, and rewritten logs, not timestamp-only changes", () => {
  const base = { file: "runtime.jsonl", size_bytes: 100, mod_time: "before", items: ["same", "same"] };
  const key = logSnapshotKey(base);
  assert.equal(key, logSnapshotKey({ ...base, mod_time: "after" }));
  assert.notEqual(key, logSnapshotKey({ ...base, size_bytes: 105 }));
  assert.notEqual(key, logSnapshotKey({ ...base, file: "next.jsonl" }));
  assert.notEqual(key, logSnapshotKey({ ...base, items: ["same", "edit"] }));
  assert.equal(logSnapshotKey({ items: null }), logSnapshotKey({ items: [] }));
});

test("event, severity, time, and text filters intersect without losing duplicate entries", () => {
  const entries = [
    { time: "2026-09-24T21:00:00+09:00", level: "WARN", msg: "request_failed", task_id: "task_a" },
    { time: "2026-09-24T12:01:00Z", level: "ERROR", msg: "request_failed", task_id: "task_a" },
    { time: "2026-09-24T12:02:00Z", level: "INFO", msg: "request_failed", task_id: "task_a" },
    { time: "2026-09-24T12:03:00Z", level: "ERROR", msg: "request_started", task_id: "task_a" },
    { time: "invalid", level: "ERROR", msg: "request_failed", task_id: "task_a" },
  ].map((entry) => parseLogLine(JSON.stringify(entry)));
  const since = Date.parse("2026-09-24T12:00:00Z");
  assert.deepEqual(filterLogEntries(entries, " TASK_A ", "issues", { event: "request_failed", since }), entries.slice(0, 2));
  assert.deepEqual(filterLogEntries(entries, "", "", { since: since + 1 }), entries.slice(1, 4));
  assert.deepEqual(filterLogEntries(entries, "", "", { event: "request" }), []);
  assert.deepEqual(filterLogEntries([entries[0], entries[0]], "", "issues"), [entries[0], entries[0]]);
  assert.deepEqual(filterLogEntries(entries, "", "error", { event: "request_failed" }), [entries[1], entries[4]]);
});

test("only structured message names are selectable events; undated lines survive unrestricted filtering", () => {
  const raw = parseLogLine("request_failed");
  const structured = parseLogLine('{"msg":"request_failed"}');
  assert.equal(raw.event, "");
  assert.equal(structured.event, "request_failed");
  assert.deepEqual(filterLogEntries([raw, structured], "", ""), [raw, structured]);
  assert.deepEqual(filterLogEntries([raw, structured], "", "", { event: "request_failed" }), [structured]);
  assert.deepEqual(filterLogEntries([raw, structured], "", "", { since: 0 }), []);
});

test("field previews flatten multi-line values and cap long ones", () => {
  const entry = parseLogLine(JSON.stringify({ level: "INFO", msg: "x", context: { host: "a" }, body: "y".repeat(200) }));
  const preview = logFieldPreview(entry.fields);
  assert.deepEqual(preview[0], ["context", '{"host":"a"}']);
  assert.equal(preview[1][1].length, 120);
  assert.ok(preview[1][1].endsWith("…"));
  assert.equal(logFieldPreview(entry.fields, 1).length, 1);
});

test("clock and day helpers tolerate missing or invalid times", () => {
  assert.equal(logClock("", "en"), "");
  assert.equal(logDayKey("nope"), "");
  assert.equal(logDayLabel(undefined, "en"), "");
  assert.match(logClock("2026-09-21T04:05:06.789Z", "en"), /^\d{2}:05:06\.789$/);
  assert.equal(logDayKey("2026-09-21T12:00:00"), "2026-9-21");
  assert.equal(logDayLabel("2026-09-21T12:00:00", "en"), "2026-09-21 Mon");
});
