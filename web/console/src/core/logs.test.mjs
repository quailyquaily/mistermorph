import assert from "node:assert/strict";
import test from "node:test";
import { filterLogEntries, logSnapshotKey, parseLogLine } from "./logs.js";

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
