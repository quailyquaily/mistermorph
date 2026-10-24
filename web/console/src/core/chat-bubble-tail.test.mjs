import assert from "node:assert/strict";
import test from "node:test";

import { borderWidth, chatBubbleTail } from "./chat-bubble-tail.js";

test("the tail's line has the width the browser gives a 1px border", () => {
  for (const [dpr, devicePixels] of [[1, 1], [1.25, 1], [1.5, 1], [1.75, 1], [2, 2], [2.5, 2], [3, 3]]) {
    assert.ok(Math.abs(borderWidth(dpr) * dpr - devicePixels) < 1e-9, `dpr ${dpr}`);
  }
  assert.equal(borderWidth(0), 1);
  assert.equal(borderWidth(Number.NaN), 1);
});

test("chatBubbleTail draws its outline at that width and sizes its box to fit", () => {
  const tail = chatBubbleTail(1.5);
  assert.equal(Number(tail.line.toFixed(3)), 0.667);
  assert.ok(tail.width >= 9 && tail.width <= 11);
  assert.ok(tail.height >= 16 && tail.height <= 18);
  const stroke = decodeURIComponent(tail.stroke);
  assert.match(stroke, /stroke-width='0\.667'/);
  // The outline starts on the right border's centre and ends on the top border's.
  assert.match(stroke, /d='M0\.333 /);
  assert.match(stroke, / L0 0\.333'/);
  assert.match(decodeURIComponent(tail.fill), /fill='black'/);
  assert.equal(chatBubbleTail(1).line, 1);
});
