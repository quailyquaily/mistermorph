// Messaging a running subagent from its panel (components/chat/WorkerMessageComposer.tsx): the field
// sends to that worker, the message shows queued until the runtime reports it applied (with the
// step), finished and coder workers have no field (a coder's panel says why), a worker that finished
// meanwhile keeps the draft and offers the main agent only when asked, the field fits a 360pt
// phone, and the strings follow the Console's language.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };
type FixtureEvent = { name: string; data: any };

async function openPanel(params: Record<string, unknown> = {}) {
  const app = await open("./fixtures/chat-worker-message-app.tsx", {
    width: 360,
    height: 760,
    platform: "android",
    locale: "en-US",
    host: { params, handlers: { "morph.fixture.event": null } },
  });
  await app.press("id:lang-en");
  const events = (name: string) =>
    app.host
      .posts()
      .filter((post) => post.name === "morph.fixture.event")
      .map((post) => post.data as FixtureEvent)
      .filter((event) => event.name === name)
      .map((event) => event.data);
  const frames = () => {
    const out: Record<string, Frame> = {};
    for (const part of events("part")) out[part.name] = part.frame;
    return out;
  };
  return { app, events, frames };
}

test("the field sends to that worker; the message shows queued, then applied at its step", async () => {
  const { app, events } = await openPanel();
  await app.waitUntil(() => app.count("id:chat-worker-message-input") === 1);
  expect(app.count("id:chat-worker-message-send")).toBe(1);

  await app.type("id:chat-worker-message-input", "use metric units");
  await app.press("id:chat-worker-message-send");
  await app.waitUntil(() => events("send").length === 1);
  expect(events("send")[0]).toEqual({ workerID: "worker-1", text: "use metric units" });
  // Shown queued at once, before the runtime reports it.
  await app.waitUntil(() => app.count("id:chat-worker-message-status.queued") === 1);
  expect(app.texts()).toContain("use metric units");
  expect(app.texts()).toContain("Queued: Curie takes it at its next step");

  // The runtime reports it queued: still one message.
  await app.host.send("morph.fixture.messages", [{ text: "use metric units", status: "queued" }]);
  expect(app.count("id:chat-worker-message-status.queued")).toBe(1);
  expect(app.texts().filter((text) => text === "use metric units").length).toBe(1);

  // Then applied, at the step it took it in.
  await app.host.send("morph.fixture.messages", [{ text: "use metric units", status: "applied", step: 3 }]);
  await app.waitUntil(() => app.count("id:chat-worker-message-status.applied") === 1);
  expect(app.count("id:chat-worker-message-status.queued")).toBe(0);
  expect(app.texts()).toContain("Applied at step 3");
  // Nothing went to the main agent.
  expect(events("parent")).toEqual([]);
});

test("a finished worker's panel has no field, and a coder's says why it has none", async () => {
  const { app } = await openPanel();
  await app.waitUntil(() => app.count("id:chat-worker-message-input") === 1);

  await app.press("id:pick-worker-3");
  await app.waitUntil(() => app.count("id:chat-worker-message-input") === 0);
  expect(app.count("id:chat-worker-message")).toBe(0);
  expect(app.count("id:chat-worker-message-coder")).toBe(0);

  await app.press("id:pick-worker-2");
  await app.waitUntil(() => app.count("id:chat-worker-message-coder") === 1);
  expect(app.count("id:chat-worker-message-input")).toBe(0);
  expect(app.texts()).toContain("Einstein runs an external coding CLI, which cannot take messages while it runs.");
});

test("a worker that finished meanwhile keeps the draft and offers the main agent, only when asked", async () => {
  const { app, events } = await openPanel({ refuse: "child_finished" });
  await app.waitUntil(() => app.count("id:chat-worker-message-input") === 1);
  await app.type("id:chat-worker-message-input", "also add a title");
  await app.press("id:chat-worker-message-send");
  await app.waitUntil(() => app.count("id:chat-worker-message-error") === 1);
  expect(app.texts()).toContain("Curie has already finished, so this was not sent.");
  expect(events("send")).toEqual([{ workerID: "worker-1", text: "also add a title" }]);
  // Not sent anywhere else, and not shown as sent.
  expect(events("parent")).toEqual([]);
  expect(app.count("id:chat-worker-message-status.queued")).toBe(0);

  await app.press("id:chat-worker-message-to-parent");
  await app.waitUntil(() => events("parent").length === 1);
  expect(events("parent")[0]).toEqual({ text: "also add a title" });
  await app.waitUntil(() => app.count("id:chat-worker-message-notice") === 1);
  expect(app.texts()).toContain("Sent to the main agent.");
  expect(app.count("id:chat-worker-message-error")).toBe(0);
});

test("a refusal that is not about finishing offers no other target", async () => {
  const { app } = await openPanel({ refuse: "full" });
  await app.waitUntil(() => app.count("id:chat-worker-message-input") === 1);
  await app.type("id:chat-worker-message-input", "one more");
  await app.press("id:chat-worker-message-send");
  await app.waitUntil(() => app.count("id:chat-worker-message-error") === 1);
  expect(app.texts()).toContain("Could not send: refused: full");
  expect(app.count("id:chat-worker-message-to-parent")).toBe(0);
});

test("the field and its send button fit a 360pt phone", async () => {
  const { app, frames } = await openPanel();
  await app.waitUntil(() => ["worker-message", "worker-message-field", "worker-message-send"].every((name) => frames()[name]));
  const { "worker-message": foot, "worker-message-field": field, "worker-message-send": send } = frames();
  expect(foot.x).toBeGreaterThanOrEqual(0);
  expect(foot.x + foot.w).toBeLessThanOrEqual(360);
  expect(field.x).toBeGreaterThanOrEqual(foot.x);
  expect(field.x + field.w).toBeLessThanOrEqual(send.x);
  expect(send.x + send.w).toBeLessThanOrEqual(360);
  expect(send.w).toBeGreaterThanOrEqual(32);
  expect(field.w).toBeGreaterThanOrEqual(200);
});

test("the strings follow the Console's language", async () => {
  const { app } = await openPanel();
  await app.waitUntil(() => app.count("id:chat-worker-message-input") === 1);
  await app.type("id:chat-worker-message-input", "use metric units");
  await app.press("id:chat-worker-message-send");
  await app.waitUntil(() => app.count("id:chat-worker-message-status.queued") === 1);
  await app.press("id:lang-zh");
  await app.waitUntil(() => app.texts().includes("已排队：居里 会在下一步收到"));
  await app.host.send("morph.fixture.messages", [{ text: "use metric units", status: "applied", step: 2 }]);
  await app.waitUntil(() => app.texts().includes("已在第 2 步收到"));
  await app.press("id:pick-worker-2");
  await app.waitUntil(() => app.texts().includes("爱因斯坦 运行的是外部编码命令行工具，运行期间无法接收消息。"));
  await app.press("id:lang-ja");
  await app.waitUntil(() => app.texts().includes("アインシュタイン は外部のコーディング CLI を実行しているため、実行中はメッセージを受け取れません。"));
  await app.press("id:pick-worker-1");
  await app.waitUntil(() => app.texts().includes("ステップ 2 で反映"));
});
