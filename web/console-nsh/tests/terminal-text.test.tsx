// The terminal's typed text (components/chat/TerminalText.tsx): which terms get a colour, which
// can be copied, how a long value is cut without cutting a term worth copying; and in the panel, a
// pressed URL is copied whole.
import { expect, test } from "nsh/test";
import { limitTerms, terminalTerms } from "../components/chat/TerminalText";
import { openConsole, type ApiRequest } from "./harness";

const kinds = (text: string, options?: { copyOnly?: boolean }) =>
  terminalTerms(text, options)
    .filter((term) => term.kind !== "plain")
    .map((term) => `${term.kind}:${term.text}`);

test("terms: URLs, IDs, paths, numbers and literals", () => {
  expect(kinds("fetch https://example.com/a?b=1, then stop.")).toEqual(["url:https://example.com/a?b=1"]);
  expect(kinds("task 3f2a1c9e-0b4d-4c1e-9a2b-1234567890ab done")).toEqual(["id:3f2a1c9e-0b4d-4c1e-9a2b-1234567890ab"]);
  expect(kinds("id=task_8f3k2l")).toEqual(["id:task_8f3k2l"]);
  expect(kinds("at commit 6d839cb0")).toEqual(["id:6d839cb0"]);
  expect(kinds("ls -la /home/user/projects/x.go")).toEqual(["path:/home/user/projects/x.go"]);
  expect(kinds("open ~/notes/today.md")).toEqual(["path:~/notes/today.md"]);
  expect(kinds("took 250ms, 3 files, ok=true")).toEqual(["number:250ms", "number:3", "literal:true"]);
  // A URL's path is the URL's; a word's slash is not a path; plain words stay plain.
  expect(kinds("https://example.com/docs/page")).toEqual(["url:https://example.com/docs/page"]);
  expect(kinds("either/or and deadline")).toEqual([]);
  // Output and errors mark only what is worth copying.
  expect(kinds("wrote 3 files to /tmp/out in 2s: true", { copyOnly: true })).toEqual(["path:/tmp/out"]);
});

test("a long value is cut in its plain text, never inside a URL or an ID", () => {
  const text = `${"x".repeat(10)} https://example.com/a/very/long/url ${"y".repeat(50)}`;
  const cut = limitTerms(terminalTerms(text), 30);
  // The URL did not fit: it is left out whole, not cut.
  expect(cut.some((term) => term.kind === "url")).toBe(false);
  expect(cut.at(-1)?.text).toBe("...");
  const roomy = limitTerms(terminalTerms(text), 60);
  expect(roomy.find((term) => term.kind === "url")?.text).toBe("https://example.com/a/very/long/url");
});

test("in the panel, a pressed URL or number is copied whole (IDs inside output: the terms above)", async () => {
  const NOW = new Date().toISOString();
  const TASK = {
    id: "t1",
    task: "Fetch",
    topic_id: "topic-1",
    created_at: NOW,
    started_at: NOW,
    status: "done",
    finished_at: NOW,
    result: {
      final: { output: "ok" },
      activity: {
        history: [
          {
            id: "a1",
            kind: "tool",
            name: "url_fetch",
            status: "done",
            args: { url: "https://example.com/report?id=42", retries: 3 },
            output: "saved as task_8f3k2l",
          },
        ],
      },
    },
  };
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } },
      "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [TASK] : [] } }),
      "GET /proxy:/topic/topic-1/metadata": { body: { workspace: { workspace_dir: "", source: "none" } } },
    },
  });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
  // The value is the URL alone: pressing it copies it whole.
  await app.press("id:chat-detail-activity >> text:https://example.com/report?id=42");
  expect(app.clipboard()).toBe("https://example.com/report?id=42");
  // Marked copied by its colour alone: no mark beside it.
  expect(app.texts().some((text) => text.includes("✓"))).toBe(false);
  // A number is a coloured term too: it copies.
  await app.press("id:chat-detail-activity >> text:3");
  expect(app.clipboard()).toBe("3");
});
