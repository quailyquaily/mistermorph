import assert from "node:assert/strict";
import test from "node:test";

import { dismissNotice, isNetworkErrorMessage, noticeState, normalizeNoticeType, pushNotice, useNotice } from "./notices.js";

function clear() {
  for (const item of [...noticeState.items]) {
    dismissNotice(item.id);
  }
}

test("normalizeNoticeType maps danger to error and unknown types to info", () => {
  assert.equal(normalizeNoticeType("danger"), "error");
  assert.equal(normalizeNoticeType("Warning"), "warning");
  assert.equal(normalizeNoticeType("whatever"), "info");
});

test("isNetworkErrorMessage recognises browser network failures only", () => {
  assert.equal(isNetworkErrorMessage("Failed to fetch"), true);
  assert.equal(isNetworkErrorMessage("NetworkError when attempting to fetch resource."), true);
  assert.equal(isNetworkErrorMessage("Load failed"), true);
  assert.equal(isNetworkErrorMessage("profile not found"), false);
});

test("useNotice shows typed notices and refreshes a repeated message instead of stacking it", () => {
  clear();
  const notice = useNotice();
  notice.success("Saved.", { timeout: 0 });
  notice.success("Saved.", { timeout: 0 });
  notice.error("Could not save.", { timeout: 0 });
  assert.deepEqual(
    noticeState.items.map((item) => [item.type, item.text]),
    [
      ["success", "Saved."],
      ["error", "Could not save."],
    ],
  );
  clear();
});

test("a notice with an id is updated in place, and empty text dismisses it", () => {
  clear();
  pushNotice({ id: "page", type: "error", text: "first", timeout: 0 });
  pushNotice({ id: "page", type: "error", text: "second", timeout: 0 });
  assert.equal(noticeState.items.length, 1);
  assert.equal(noticeState.items[0].text, "second");
  pushNotice({ id: "page", type: "error", text: "", timeout: 0 });
  assert.equal(noticeState.items.length, 0);
});

test("the stack keeps at most four notices, dropping the oldest unpinned one first", () => {
  clear();
  pushNotice({ id: "page", type: "error", text: "pinned", timeout: 0 });
  for (const text of ["a", "b", "c", "d"]) {
    pushNotice({ type: "info", text, timeout: 0 });
  }
  assert.deepEqual(
    noticeState.items.map((item) => item.text),
    ["pinned", "b", "c", "d"],
  );
  clear();
});

test("timed notices dismiss themselves", async () => {
  clear();
  pushNotice({ type: "success", text: "gone soon", timeout: 10 });
  assert.equal(noticeState.items.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(noticeState.items.length, 0);
});
