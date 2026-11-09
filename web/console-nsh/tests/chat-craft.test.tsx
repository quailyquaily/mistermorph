// The chat's computed details: code text.
import { expect, test } from "nsh/test";
import { expandTabs, highlightCode } from "../components/chat/codeHighlight";

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
