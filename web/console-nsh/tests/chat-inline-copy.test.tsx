// Inline code in a reply copies its text when pressed: before the reply is shown, each inline code
// span becomes a link around itself that copies (components/chat/inlineCopy.ts).
import { expect, test } from "nsh/test";
import { inlineCopyText, linkInlineCode } from "../components/chat/inlineCopy";

const copied = (markdown: string) =>
  [...linkInlineCode(markdown).matchAll(/\]\((mmcopy:[^)]*)\)/g)].map((match) => inlineCopyText(match[1]));

test("each inline code span copies its own text, without the backticks", () => {
  expect(copied("Run `go test ./...` then `make` and retry on `5xx`.")).toEqual(["go test ./...", "make", "5xx"]);
  // Double backticks hold a backtick; one space at each end is the span's padding, not its text.
  expect(copied("Use `` `cmd` `` here.")).toEqual(["`cmd`"]);
  // Parentheses and spaces survive the link's destination.
  expect(copied("Call `f(a, b)` now.")).toEqual(["f(a, b)"]);
  // The code keeps its look: the span is the link's text.
  expect(linkInlineCode("A `b` c")).toBe("A [`b`](mmcopy:b) c");
});

test("fenced blocks, code inside links, unclosed and escaped backticks stay as they are", () => {
  const fenced = "Before `x`\n```sh\necho `y`\n```\nAfter `z`";
  expect(copied(fenced)).toEqual(["x", "z"]);
  expect(linkInlineCode(fenced)).toContain("echo `y`");
  expect(copied("See [the `docs` page](https://example.com).")).toEqual([]);
  expect(linkInlineCode("Still streaming `go te")).toBe("Still streaming `go te");
  expect(linkInlineCode("A literal \\`tick\\` here")).toBe("A literal \\`tick\\` here");
  expect(linkInlineCode("No code here.")).toBe("No code here.");
});

test("an ordinary link is not a copy", () => {
  expect(inlineCopyText("https://example.com")).toBeNull();
  expect(inlineCopyText("mmcopy:%E4%BD%A0%E5%A5%BD")).toBe("你好");
});
