// The topic's context window page: the overview, a part's items, an item's text, and its failures.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const PAGE = "/e/default/chat/topic-1/context";
const KEY = "GET /proxy:/topic/topic-1/context";

const SNAPSHOT = {
  available: true,
  context_window_tokens: 100000,
  input_tokens: 4000,
  compaction_trigger_tokens: 80000,
  method: "provider",
  parts: [
    {
      kind: "system",
      tokens: 1000,
      children: [
        { kind: "section", label: "Persona", tokens: 700, content: "## Persona\nYou are Morph, a helpful agent." },
        { kind: "section", label: "Rules", tokens: 300, content: "Be brief.", cache_breakpoint: true, cache_ttl: "1h" },
      ],
    },
    {
      kind: "history",
      tokens: 3000,
      children: [
        { kind: "message", role: "user", tokens: 1000, content: "What is the weather?" },
        { kind: "message", role: "assistant", tokens: 2000, content: "It is sunny today." },
      ],
    },
  ],
};

test("the overview shows the total, the parts, and opens on the largest part and item", async () => {
  const { app } = await openConsole({ location: PAGE, api: { [KEY]: { body: SNAPSHOT } } });
  await app.waitFor("id:context-overview");
  expect(app.texts()).toContain("4,000 tokens");
  expect(app.texts()).toContain("4.0%");
  await app.waitFor("Counted by the provider.");
  await app.waitFor("id:context-part-system");
  await app.waitFor("id:context-part-history");
  // History is the largest part; its largest item is the agent's message.
  await app.waitFor("id:context-items");
  await app.waitFor("text:It is sunny today.");
  // Another part, then another item.
  await app.press("id:context-part-system");
  await app.waitFor("id:context-item-system:0");
  expect(app.texts().some((text) => text.includes("You are Morph, a helpful agent."))).toBe(true);
  await app.press("id:context-item-system:1");
  await app.waitFor("text:Be brief.");
  await app.waitFor("Cache tag · 1h");
  // The selected part again clears the selection.
  await app.press("id:context-part-system");
  await app.waitFor("Select a part to see what it holds.");
});

test("back leaves for the topic's chat", async () => {
  const { app, calls } = await openConsole({ location: PAGE, api: { [KEY]: { body: SNAPSHOT } } });
  await app.waitFor("id:context-overview");
  await app.press("id:context-back");
  await app.waitFor("id:context-page", { state: "gone" });
  // The chat opens on that topic: it asks for it by its id.
  await app.waitUntil(() => calls.some((call) => call.uri === "/topics/topic-1"));
  expect(app.host.calls().some((call) =>
    call.name === "morph.history" && (call.data as any)?.op === "push" && (call.data as any)?.url === "/e/default/chat/topic-1",
  )).toBe(true);
});

test("a runtime without the route says it cannot show the window", async () => {
  const { app } = await openConsole({ location: PAGE, api: { [KEY]: { status: 404, body: { error: "not found" } } } });
  await app.waitFor("This runtime cannot show the context window. Update it to the latest version.");
});

test("a failed load shows the error", async () => {
  const { app } = await openConsole({ location: PAGE, api: { [KEY]: { status: 500, body: { error: "context exploded" } } } });
  await app.waitFor("context exploded");
  expect(app.shows("id:context-overview")).toBe(false);
});

test("a topic with no request yet says so", async () => {
  const { app } = await openConsole({ location: PAGE, api: { [KEY]: { body: { available: false } } } });
  await app.waitFor("Nothing to show yet: send a message in this topic first.");
});

test("on a phone each level is a step: overview, items, text, and back up", async () => {
  const { app } = await openConsole({ location: PAGE, width: 390, height: 844, api: { [KEY]: { body: SNAPSHOT } } });
  await app.waitFor("id:context-overview");
  // Nothing is selected until a part is chosen.
  expect(app.shows("id:context-items")).toBe(false);
  await app.press("id:context-part-history");
  await app.waitFor("id:context-items");
  expect(app.shows("id:context-overview")).toBe(false);
  await app.waitFor("History");
  await app.waitFor("text:What is the weather?");
  await app.press("id:context-item-history:0");
  await app.waitFor("id:context-text");
  expect(app.shows("id:context-items")).toBe(false);
  await app.press("id:context-back");
  await app.waitFor("id:context-items");
  await app.press("id:context-back");
  await app.waitFor("id:context-overview");
  expect(app.shows("id:context-page")).toBe(true);
});
