// The chat's drawn and computed details: the bubble tail's device-pixel line, and code text.
import { expect, test } from "nsh/test";
import { borderWidth, bubbleTail } from "../components/chat/bubbleTail";
import { expandTabs, highlightCode } from "../components/chat/codeHighlight";

test("the tail's line has the width a 1pt border is drawn at", () => {
  for (const [dpr, devicePixels] of [[1, 1], [1.25, 1], [1.5, 1], [1.75, 1], [2, 2], [2.5, 2], [3, 3]]) {
    expect(Math.abs(borderWidth(dpr) * dpr - devicePixels) < 1e-9).toBe(true);
  }
  expect(borderWidth(0)).toBe(1);
  expect(borderWidth(Number.NaN)).toBe(1);
  const tail = bubbleTail(1.5);
  expect(Number(tail.line.toFixed(3))).toBe(0.667);
  expect(tail.width >= 9 && tail.width <= 11).toBe(true);
  expect(tail.height >= 16 && tail.height <= 18).toBe(true);
  // The outline starts on the right border's centre and ends on the top border's.
  expect(Number(tail.outline.start[0].toFixed(3))).toBe(0.333);
  expect(Number(tail.outline.end[1].toFixed(3))).toBe(0.333);
});

test("tabs in code become spaces up to the next tab stop", () => {
  expect(expandTabs("\tdelay := 200")).toBe("        delay := 200");
  expect(expandTabs("ab\tc\n\t\td", 4)).toBe("ab  c\n        d");
  expect(expandTabs("no tabs")).toBe("no tabs");
});

test("the highlighter keeps the text and marks keywords, strings, numbers and calls", () => {
  const code = 'func retry() error {\n\treturn fmt.Errorf("gave up %d", 3) // done\n}';
  const tokens = highlightCode(code, "go");
  expect(tokens.map((token) => token.text).join("")).toBe(code);
  const kind = (text: string) => tokens.find((token) => token.text === text)?.kind;
  expect(kind("func")).toBe("keyword");
  expect(kind("retry")).toBe("function");
  expect(kind('"gave up %d"')).toBe("string");
  expect(kind("3")).toBe("number");
  expect(kind("// done")).toBe("comment");
  expect(highlightCode("# not a comment", "go").some((token) => token.kind === "comment")).toBe(false);
  expect(highlightCode("# a comment", "sh")[0].kind).toBe("comment");
});
