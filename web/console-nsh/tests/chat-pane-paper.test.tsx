// The phone's conversation over the topic list (FT129): a new topic, or an open one, slides in
// over the list as a pane of the chat page (components/motion/PaneStack.tsx). The pane draws on
// the page's paper, opaque, so the list shows only where the moving pane is not; with no fill of
// its own the list's rows showed through the new topic's empty page. Headless nsh has no style
// query: the fill is checked on the class the pane stack gives (`paper`, held mid-slide on
// tests/fixtures/pane-stack-app.tsx), on the theme's colour, and on the real page through the
// pane's test id (`chat-conversation-pane.paper`, from the same value as its class). The frames
// in between were looked at in Chrome.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import theme from "../theme.json";
import { PANE_PAPER } from "../components/motion/PaneStack";
import { conversationPaneTestID } from "../pages/chat/ChatPage";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
const api = (topics = TOPICS) => ({ "GET /proxy:/topics": topics, "GET /proxy:/tasks": EMPTY, "GET /proxy:/todo/tasks": EMPTY });
const PAPER = "id:chat-conversation-pane.paper";
const BARE = "id:chat-conversation-pane";
const LIST = "id:chat-topic-sidebar";

test("a sliding pane's paper is the frame's, opaque in every theme", () => {
  expect(PANE_PAPER).toBe("bg-paper");
  // No tint: a `/NN` fill is a glass bar's, see-through.
  expect(PANE_PAPER).not.toContain("/");
  const vars = (theme as { cssVars: Record<string, Record<string, string>> }).cssVars;
  for (const scheme of ["light", "dark"]) {
    // #rrggbb: no alpha.
    expect(vars[scheme].background).toMatch(/^#[0-9a-f]{6}$/i);
  }
  expect(conversationPaneTestID(PANE_PAPER)).toBe("chat-conversation-pane.paper");
  expect(conversationPaneTestID("")).toBe("chat-conversation-pane");
});

const read = (app: App, prefix: string) => (app.texts().find((text) => text.startsWith(prefix)) ?? "").slice(prefix.length);

async function openPanes(reducedMotion = false) {
  return open("./fixtures/pane-stack-app.tsx", { width: 390, height: 700, locale: "en-US", platform: "android", reducedMotion });
}

test("both panes keep their paper while one slides over the other, in and back out", async () => {
  const app = await openPanes();
  expect(read(app, "paper=")).toBe("bg-paper,bg-paper,bg-paper");
  // Mid-push: the list still there underneath, the item above it (the list is the one restacked).
  await app.press("id:open");
  expect(app.count("id:pane.0.out")).toBe(1);
  expect(app.count("id:pane.1")).toBe(1);
  expect(read(app, "plays=")).toBe("390>0 0>-117");
  expect(read(app, "paper=")).toBe("bg-paper,bg-paper,bg-paper");
  expect(read(app, "z=")).toBe("-1,0,0");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.0.out") === 0);
  expect(read(app, "paper=")).toBe("bg-paper,bg-paper,bg-paper");
  // Mid-pop: the item goes out over the list.
  await app.press("id:back");
  expect(app.count("id:pane.1.out")).toBe(1);
  expect(app.count("id:pane.0")).toBe(1);
  expect(read(app, "paper=")).toBe("bg-paper,bg-paper,bg-paper");
  expect(read(app, "z=")).toBe("0,1,0");
  // Turned round part-way, still.
  await app.press("id:open");
  expect(read(app, "paper=")).toBe("bg-paper,bg-paper,bg-paper");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.0.out") === 0);
  // Side by side (a wide window): the panes add no fill.
  await app.press("id:wide");
  expect(read(app, "paper=")).toBe("-,-,-");
});

test("with reduced motion the panes switch at once, on the same paper", async () => {
  const app = await openPanes(true);
  await app.press("id:open");
  expect(app.count("id:pane.0")).toBe(0);
  expect(read(app, "plays=")).toBe("");
  expect(read(app, "paper=")).toBe("bg-paper,bg-paper,bg-paper");
});

for (const platform of [undefined, "android"] as const) {
  const where = platform ? "the Android phone" : "a narrow web window";
  test(`on ${where} a new topic slides in over the topic list on the page's paper, and back out`, async () => {
    const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, ...(platform ? { platform } : {}), api: api() });
    await app.waitFor("id:chat-topic-new-fab");
    expect(app.count(PAPER)).toBe(0);
    await app.press("id:chat-topic-new-fab");
    // The pane is on its paper from its first frame (the frames in between are held on the
    // fixture, above).
    expect(app.count(PAPER)).toBe(1);
    expect(app.count(BARE)).toBe(0);
    // In place: the list has gone, the new topic keeps its bar, its form and its composer.
    await app.waitFor(LIST, { state: "gone" });
    expect(app.count(PAPER)).toBe(1);
    await app.waitFor("id:chat-back");
    await app.waitFor("id:chat-placeholder");
    await app.waitFor("id:chat-composer-input");
    // Back: the pane goes out over the list, on its paper until it has gone.
    if (platform) await app.back();
    else await app.press("id:chat-back");
    await app.waitFor("id:chat-topic-topic-1");
    await app.waitFor(PAPER, { state: "gone" });
    await app.waitFor("id:chat-topic-new-fab");
    // An open topic is the same pane.
    await app.press("id:chat-topic-topic-1");
    expect(app.count(PAPER)).toBe(1);
    await app.waitFor(LIST, { state: "gone" });
    await app.waitFor("id:chat-back");
  });
}

test("with reduced motion the new topic replaces the list at once, on the same paper", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, reducedMotion: true, api: api() });
  await app.waitFor("id:chat-topic-new-fab");
  await app.press("id:chat-topic-new-fab");
  expect(app.count(LIST)).toBe(0);
  expect(app.count(PAPER)).toBe(1);
  await app.waitFor("id:chat-composer-input");
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.count(PAPER)).toBe(0);
});

test("a phone with no topics yet shows the new topic as the page, usable", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, api: api(EMPTY) });
  await app.waitFor("id:chat-placeholder");
  await app.waitFor("id:chat-composer-input");
  expect(app.count(PAPER)).toBe(1);
  expect(app.count(LIST)).toBe(0);
  expect(app.shows("id:chat-back")).toBe(false);
  await app.waitFor("id:mobile-bottom-nav");
});

test("a wide window's conversation stands beside the topics with no fill of its own", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", api: api() });
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.count(BARE)).toBe(1);
  expect(app.count(PAPER)).toBe(0);
  expect(app.count(LIST)).toBe(1);
  // Narrowed to a phone and widened again, the pane takes the paper and lets it go.
  await app.setViewport(390, 844);
  await app.waitFor("id:chat-topic-new-fab");
  await app.press("id:chat-topic-new-fab");
  await app.waitFor(PAPER);
  await app.setViewport(1280, 800);
  await app.waitFor(BARE);
  expect(app.count(PAPER)).toBe(0);
});
