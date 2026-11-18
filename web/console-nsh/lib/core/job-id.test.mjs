import assert from "node:assert/strict";
import test from "node:test";

import { isGeneratedJobID, newJobID, uuidV4 } from "./job-id.js";

// The same form as the runtime's cron.NewJobID (internal/cron/jobid.go).
const RUNTIME_FORM = /^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("new job IDs are job-<uuid v4>, unique, in the runtime's form", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = newJobID();
    assert.match(id, RUNTIME_FORM);
    assert.equal(isGeneratedJobID(id), true);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
});

test("the version and variant bits are set whatever the random bytes", () => {
  assert.equal(uuidV4((bytes) => bytes.fill(0xff)), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  assert.equal(uuidV4((bytes) => bytes.fill(0)), "00000000-0000-4000-8000-000000000000");
  assert.equal(newJobID((bytes) => bytes.fill(0)), "job-00000000-0000-4000-8000-000000000000");
});

test("legacy IDs are not generated ones, but nothing rejects them", () => {
  for (const id of ["task-1", "cron-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c", "weekly-report", "job-1", "", null]) {
    assert.equal(isGeneratedJobID(id), false, String(id));
  }
});
