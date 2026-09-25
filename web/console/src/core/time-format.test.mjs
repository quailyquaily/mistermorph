import assert from "node:assert/strict";
import test from "node:test";
import { formatShortTimestamp } from "./time-format.js";

const now = new Date(2026, 8, 25, 21, 0, 0);

test("short timestamps drop the parts the reader already knows", () => {
  const today = formatShortTimestamp(new Date(2026, 8, 25, 9, 26, 30).toISOString(), "en-GB", now);
  assert.match(today, /^09:26$/, "today shows the time only");

  const thisYear = formatShortTimestamp(new Date(2026, 8, 22, 0, 45).toISOString(), "en-GB", now);
  assert.match(thisYear, /22/, "this year keeps the day");
  assert.match(thisYear, /00:45/, "this year keeps the time");
  assert.doesNotMatch(thisYear, /2026/, "this year omits the year");

  const older = formatShortTimestamp(new Date(2025, 11, 31, 23, 59).toISOString(), "en-GB", now);
  assert.match(older, /2025/, "older values keep the year");
  assert.doesNotMatch(older, /:/, "older values omit the time");
});

test("missing or invalid timestamps stay readable", () => {
  assert.equal(formatShortTimestamp("", "en", now), "-");
  assert.equal(formatShortTimestamp(null, "en", now), "-");
  assert.equal(formatShortTimestamp("not a time", "en", now), "not a time");
});
