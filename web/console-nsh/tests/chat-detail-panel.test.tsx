// The temporary detail panel, in the frame's workbench (docked under the window) on wide windows: a
// reply's plan, progress, reasoning and workers open there (never inside the conversation), one at a
// time, beside the topic and workspace panel; the workbench opens at half its room and its edge
// resizes it; on phones the right sheet. Close, Escape and Back dismiss it; another conversation
// closes it; and what still streams keeps growing in it. Progress and a coder's output never repeat
// the message the reply answers at their top; the conversation keeps it.
import { batch, effect, signal, untracked } from "nsh";
import { expect, open, test, type App } from "nsh/test";
import { createFocusReturn } from "../components/chat/activityDetail";
import { localEndpoint, openConsole, type ApiRequest } from "./harness";
import { clampWorkbenchShare, workbenchHeight } from "../components/frame/Workbench";

const NOW = new Date().toISOString();
const TOPICS = {
  body: {
    items: [
      { id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW },
      { id: "topic-2", title: "Docs", created_at: NOW, updated_at: NOW },
    ],
  },
};
const CHAT = "/e/default/chat/topic-1";
const PANEL_OPEN = { mistermorph_console_workspace_sidebar_open_v1: "true" };
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

function task(id: string, extra: Record<string, unknown>) {
  return { id, task: "Clean the disk", topic_id: "topic-1", created_at: NOW, started_at: NOW, ...extra };
}

function listOf(...items: unknown[]) {
  return (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items } } : { body: { items: [] } });
}

const DONE = task("t1", {
  status: "done",
  finished_at: NOW,
  result: {
    final: { output: "All **done**." },
    reasoning: "First I looked at the biggest folders.",
    plan: { steps: [{ step: "Look around", status: "completed" }, { step: "Clean up", status: "completed" }] },
    activity: {
      history: [{ id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: "du -sh" } }],
      workers: [
        { id: "w1", name: "Curie", name_index: 1, avatar_index: 0, kind: "coder", status: "done", output: "compiled 3 files" },
        { id: "w2", name: "Noether", name_index: 4, avatar_index: 1, kind: "subagent", status: "done", result: "found 2 caches" },
      ],
    },
  },
});

const API = {
  "GET /proxy:/topics": TOPICS,
  "GET /proxy:/tasks": listOf(DONE),
  "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
  "GET /proxy:/topic/topic-2/metadata": NO_WORKSPACE,
};

/** What the detail panel shows, inside the panel (not the conversation). */
function inPanel(app: App, text: string) {
  return app.shows(`id:chat-detail-panel >> text:${text}`);
}

function inConversation(app: App, text: string) {
  return app.shows(`id:chat-item-agent >> text:${text}`);
}

/** The panel's head names the message the reply answers. */
function hasContext(app: App) {
  return app.shows("id:chat-detail-context");
}

/** The user's message is still in the conversation. */
function userMessageShown(app: App) {
  return app.shows("id:chat-item-user >> text:Clean the disk");
}

async function openChat(options: { kv?: Record<string, string>; api?: Record<string, unknown> } = {}) {
  const { app, calls } = await openConsole({ location: CHAT, kv: options.kv, api: { ...API, ...(options.api || {}) } });
  await app.waitFor("id:chat-status-card");
  return { app, calls };
}

test("plan, progress, reasoning and each worker open in the panel, never inside the conversation", async () => {
  const { app } = await openChat();
  expect(app.shows("id:chat-detail-panel")).toBe(false);

  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-plan");
  expect(app.count("id:chat-detail-panel")).toBe(1);
  expect(inPanel(app, "Look around")).toBe(true);
  expect(inConversation(app, "Look around")).toBe(false);
  // Its head: the panel's name, the steps done, and the message the reply answers.
  expect(inPanel(app, "Plan")).toBe(true);
  expect(inPanel(app, "2/2")).toBe(true);
  expect(inPanel(app, "Clean the disk")).toBe(true);
  expect(hasContext(app)).toBe(true);

  // Progress: its head is the title, the mark and close, without the message it answers.
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
  expect(inPanel(app, "du -sh")).toBe(true);
  expect(inConversation(app, "du -sh")).toBe(false);
  expect(inPanel(app, "Progress")).toBe(true);
  expect(app.shows("id:chat-detail-panel >> id:chat-detail-close")).toBe(true);
  expect(hasContext(app)).toBe(false);
  expect(inPanel(app, "Clean the disk")).toBe(false);
  expect(userMessageShown(app)).toBe(true);

  await app.press("id:chat-status-reasoning");
  await app.waitFor("id:chat-detail-reasoning");
  expect(inPanel(app, "First I looked at the biggest folders.")).toBe(true);
  expect(inConversation(app, "First I looked at the biggest folders.")).toBe(false);
  // Reasoning is the run's own, as progress is: the message it answers is not repeated above it.
  expect(hasContext(app)).toBe(false);
  expect(inPanel(app, "Clean the disk")).toBe(false);

  // A coder's output: its name, avatar, output and close, without the message either.
  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-worker");
  expect(inPanel(app, "Curie")).toBe(true);
  expect(inPanel(app, "compiled 3 files")).toBe(true);
  expect(inConversation(app, "compiled 3 files")).toBe(false);
  expect(app.shows("id:chat-detail-panel >> id:chat-detail-close")).toBe(true);
  expect(hasContext(app)).toBe(false);
  expect(inPanel(app, "Clean the disk")).toBe(false);
  expect(userMessageShown(app)).toBe(true);

  // A subagent keeps it.
  await app.press("label:Noether · Subagent · Done");
  await app.waitUntil(() => inPanel(app, "Noether"));
  expect(inPanel(app, "found 2 caches")).toBe(true);
  expect(inPanel(app, "compiled 3 files")).toBe(false);
  expect(inPanel(app, "Clean the disk")).toBe(true);
  // Switching never adds a panel.
  expect(app.count("id:chat-detail-panel")).toBe(1);
  // The reply keeps its own actions.
  await app.press("id:chat-item-agent >> label:Copy");
  expect(app.clipboard()).toBe("All **done**.");
});

test("an entry pressed again, the close button and Escape dismiss the panel", async () => {
  const { app } = await openChat();
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });

  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });

  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-panel");
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  // The conversation is still there, its reply and entries untouched.
  expect(app.shows("text:All done.")).toBe(true);
  expect(app.shows("id:chat-status-plan")).toBe(true);
});

test("while a dialog is over the page, Escape is not the panel's", async () => {
  const { app } = await openChat();
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  for (let i = 0; i < 5; i += 1) await app.press("id:chat-history-status");
  await app.waitFor("RAW JSON");
  // (Headless, Escape never reaches nsh's dialog itself, with or without the panel: only that the
  // panel leaves it alone can be checked here.)
  await app.keyboard.press("escape");
  await app.wait(300);
  expect(app.shows("id:chat-detail-panel")).toBe(true);
  // The dialog closed, Escape closes the panel again.
  await app.press("id:chat-raw-json-close");
  await app.waitFor("RAW JSON", { state: "gone" });
  expect(app.shows("id:chat-detail-panel")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
});

// Escape is the topmost popup's: a menu or dialog opened over the page, or the composer's
// suggestions, take it before the panel beside the conversation, whichever opened first.
test("Escape closes the agent bubble opened over the panel before the panel", async () => {
  const { app } = await openChat();
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("label:Overview");
  await app.keyboard.press("escape");
  await app.waitFor("id:agent-switcher-list", { state: "gone" });
  expect(app.shows("id:chat-detail-panel")).toBe(true);
});

test("Escape is the agent bubble's (with its filter), opened over the panel from outside the chat page", async () => {
  const agents = Array.from({ length: 8 }, (_, index) => ({
    endpoint_ref: `ep_${index}`,
    name: `Remote ${index}`,
    url: `https://agent-${index}.example.com`,
    connected: true,
    agent_name: `Agent ${index}`,
    mode: "console",
    can_submit: true,
    avatar_url: "",
  }));
  const { app } = await openConsole({ location: CHAT, endpoints: [localEndpoint(), ...agents], api: API });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("id:agent-switcher-filter");
  await app.keyboard.press("escape");
  await app.waitFor("id:agent-switcher-list", { state: "gone" });
  expect(app.shows("id:chat-detail-panel")).toBe(true);
});

test("Escape closes the composer's suggestions shown before the panel opened, then the panel", async () => {
  const { app } = await openChat({
    api: { "GET /commands": { body: { items: [{ value: "/alpha", title: "/alpha", description: "First" }] } } },
  });
  await app.type("id:chat-composer-input", "/");
  await app.waitFor("id:chat-composer-suggestions");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  expect(app.shows("id:chat-composer-suggestions")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-composer-suggestions", { state: "gone" });
  expect(app.shows("id:chat-detail-panel")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  expect(app.value("id:chat-composer-input")).toBe("/");
});

// The entry that opened the panel takes the keyboard focus back as it closes (its `focus` effect,
// ChatStatusCard's Column, ChatWorkerRoster's chip). Headless steps cannot tell which view has the
// keyboard focus, nor press a focused button from the keyboard: the request is checked as those
// effects see it, in the same batch as the panel's close, as a key press runs.
test("the focus-return request is seen by the entries as the panel closes, then cleared", async () => {
  const focusReturn = createFocusReturn();
  const panelOpen = signal(true);
  const seen: string[] = [];
  effect(() => {
    const key = focusReturn.key();
    if (key) untracked(() => seen.push(key));
  });
  batch(() => {
    panelOpen.set(false);
    focusReturn.request("item-1\u0000plan");
  });
  expect(seen).toEqual(["item-1\u0000plan"]);
  expect(untracked(focusReturn.key)).toBe("item-1\u0000plan");
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Cleared once settled: an entry drawn later does not take the focus.
  expect(untracked(focusReturn.key)).toBe("");

  // A second close soon after takes the request over; the first one's clearing leaves it alone.
  focusReturn.request("item-1\u0000plan");
  focusReturn.request("item-1\u0000worker\u0000w1");
  expect(seen.at(-1)).toBe("item-1\u0000worker\u0000w1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(untracked(focusReturn.key)).toBe("");
  focusReturn.dispose();
});

test("closing the panel leaves the focus in the composer that had it", async () => {
  const { app } = await openChat();
  await app.type("id:chat-composer-input", "half");
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-panel");
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  // Typing goes on in the field, after its text.
  await app.keyboard.press("shift+1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half!");
});

test("on a wide window the details open in the frame's workbench, beside the workspace panel", async () => {
  const { app } = await openChat({ kv: PANEL_OPEN });
  await app.waitFor("id:chat-workspace-panel");
  // The workbench is the frame's, docked under the window (not inside the chat page); the
  // workspace panel stays at the right.
  await app.press("id:chat-status-plan");
  await app.waitFor("id:workbench >> id:chat-detail-panel");
  expect(app.shows("id:chat-page >> id:workbench")).toBe(false);
  expect(app.shows("id:chat-workspace-panel")).toBe(true);
  expect(app.shows("id:chat-right-panel >> id:chat-detail-panel")).toBe(false);
  // The workspace toggle closes the workspace panel only; the sheet stays.
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel", { state: "gone" });
  expect(app.shows("id:workbench")).toBe(true);
  // A worker takes the sheet over; the toggle brings the workspace panel back beside it.
  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-panel >> text:compiled 3 files");
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
  expect(app.count("id:chat-detail-panel")).toBe(1);
  // Closing the details leaves the workspace panel as it was.
  await app.press("id:chat-detail-close");
  await app.waitFor("id:workbench", { state: "gone" });
  expect(app.shows("id:chat-workspace-panel")).toBe(true);
});

test("the workbench's edge resizes it by drag, within its room, and the height is kept for next time", async () => {
  const KEY = "mistermorph_console_workbench_height_v1";
  // What has been kept: the last height written to the app's storage, as a share of the room.
  const kept = (app: App) => {
    const writes = app.host.calls().filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === KEY);
    return writes.length ? Number((writes.at(-1)!.data as any).value) : null;
  };
  const { app } = await openChat();
  await app.press("id:chat-status-plan");
  await app.waitFor("id:workbench");
  expect(kept(app)).toBe(null);
  // Dragged up, it grows from half, and is kept once the drag ends.
  await app.drag("id:workbench-edge", { x: 0, y: -80 });
  await app.waitUntil(() => (kept(app) ?? 0) > 0.5);
  const grown = kept(app)!;
  // Dragged far down, it stops at its least; far up, short of the top.
  await app.drag("id:workbench-edge", { x: 0, y: 2000 });
  await app.waitUntil(() => (kept(app) ?? 1) < grown);
  expect(kept(app)!).toBeGreaterThanOrEqual(0.2);
  await app.drag("id:workbench-edge", { x: 0, y: -4000 });
  await app.waitUntil(() => (kept(app) ?? 0) > grown);
  expect(kept(app)!).toBeLessThanOrEqual(0.8);
});

test("the workbench's height: its share of the room, at least its head and a few lines, leaving the composer room", () => {
  expect(workbenchHeight(800, 0.5)).toBe(400);
  expect(workbenchHeight(800, 0.05)).toBe(140);
  expect(workbenchHeight(800, 0.95)).toBe(600);
  expect(workbenchHeight(500, 0.9)).toBe(300);
  // A short room keeps the sheet's least over the room above.
  expect(workbenchHeight(300, 0.5)).toBe(140);
  // What is kept stays between a fifth and four fifths; anything unreadable is half.
  expect(clampWorkbenchShare(0.05)).toBe(0.2);
  expect(clampWorkbenchShare(0.95)).toBe(0.8);
  expect(clampWorkbenchShare(Number("x"))).toBe(0.5);
});

test("reasoning is plain mono text as written, not rendered markdown", async () => {
  const MARKED = task("t1", { status: "done", finished_at: NOW, result: { final: { output: "ok" }, reasoning: "**Check** the `du` output first." } });
  const { app } = await openChat({ api: { "GET /proxy:/tasks": listOf(MARKED) } });
  await app.press("id:chat-status-reasoning");
  await app.waitFor("id:chat-detail-reasoning-text");
  expect(app.texts()).toContain("**Check** the `du` output first.");
  expect(app.shows("id:chat-detail-panel >> id:chat-code-block")).toBe(false);
});

test("a worker's panel is its conversation: what the agent asked, the calls it made, what it answered", async () => {
  const TASK = "Find the two biggest cache folders under /var/cache and report their sizes.";
  const SPAWNED = task("t1", {
    status: "done",
    finished_at: NOW,
    result: {
      final: { output: "ok" },
      activity: {
        history: [
          {
            id: "a2",
            kind: "tool",
            name: "spawn",
            status: "done",
            args: { task: TASK, tools: ["bash", "read_file"], model_profile: "fast" },
            children: [{ id: "a2.1", kind: "tool", name: "bash", status: "done", args: { cmd: "du -sh /var/cache/*" } }],
          },
        ],
        workers: [{ id: "w2", name: "Noether", name_index: 4, avatar_index: 1, kind: "subagent", status: "done", activity_id: "a2", result: "apt 1.2G, pip 800M" }],
      },
    },
  });
  const { app } = await openChat({ api: { "GET /proxy:/tasks": listOf(SPAWNED) } });
  await app.press("label:Noether · Subagent · Done");
  await app.waitFor("id:chat-worker-ask");
  // What the agent asked, whole, and the call's settings.
  expect(app.shows("id:chat-worker-ask >> text:/^Morph > Noether$/i")).toBe(true);
  expect(app.texts()).toContain(TASK);
  expect(app.shows("id:chat-worker-ask >> text:bash, read_file")).toBe(true);
  expect(app.shows("id:chat-worker-ask >> text:fast")).toBe(true);
  // The calls it made on its own: each one text, the call and its first value.
  expect(app.shows("id:chat-worker-calls >> text:bash du -sh /var/cache/*")).toBe(true);
  // What it answered.
  expect(app.shows("id:chat-worker-answer >> text:apt 1.2G, pip 800M")).toBe(true);
});

test("another topic or a new chat closes the panel", async () => {
  const { app } = await openChat();
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:chat-topic-topic-2");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-status-card");
  // Nothing stays selected for the topic left before.
  expect(app.shows("id:chat-detail-panel")).toBe(false);

  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:chat-topic-new");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
});

test("opening and closing the panel keeps the draft", async () => {
  const { app } = await openChat();
  await app.type("id:chat-composer-input", "half a thought");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  expect(app.value("id:chat-composer-input")).toBe("half a thought");
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  expect(app.value("id:chat-composer-input")).toBe("half a thought");
});

test("a running task's progress and a worker's output keep growing in the open panel", async () => {
  let polls = 0;
  const running = () => {
    polls += 1;
    const step = Math.min(polls, 4);
    const history = Array.from({ length: step }, (_, index) => ({ id: `a${index + 1}`, kind: "tool", name: "bash", status: index + 1 < step ? "done" : "running", args: { cmd: `step-${index + 1}` } }));
    return task("t1", {
      status: "running",
      result: {
        activity: {
          history,
          workers: [{ id: "w1", name: "Curie", name_index: 1, avatar_index: 0, kind: "coder", status: "running", output: Array.from({ length: step }, (_, i) => `line ${i + 1}`).join("\n") }],
        },
      },
    });
  };
  const { app } = await openChat({
    api: {
      "GET /proxy:/tasks": (request: ApiRequest) => listOf(running())(request),
      "GET /proxy:/tasks/t1": () => ({ body: running() }),
    },
  });
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
  const before = polls;
  await app.waitUntil(() => polls > before + 1 && inPanel(app, `step-${Math.min(polls, 4)}`), { timeout: 8000 });
  await app.waitFor("id:chat-detail-panel >> text:step-4", { timeout: 8000 });
  // While it streams, nothing above the progress either.
  expect(hasContext(app)).toBe(false);

  await app.press("label:Curie · Coder · Running");
  await app.waitFor("id:chat-detail-worker");
  await app.waitUntil(() => app.texts().some((text) => text.includes("line 4")), { timeout: 8000 });
  expect(app.count("id:chat-detail-panel")).toBe(1);
  expect(hasContext(app)).toBe(false);
  expect(userMessageShown(app)).toBe(true);
});

test("on a phone the details slide up in the workbench at the bottom, and Back closes it to the conversation", async () => {
  const { app } = await openConsole({ platform: "android", location: CHAT, api: API });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:workbench >> id:chat-detail-panel");
  // Its grab strip shows it can change height.
  expect(app.shows("id:workbench >> id:workbench-handle")).toBe(true);
  expect(inPanel(app, "Look around")).toBe(true);
  expect(hasContext(app)).toBe(true);
  expect(app.shows("id:chat-workspace-panel")).toBe(false);
  // Progress and a coder's output in the sheet: no message above them, the conversation keeps it.
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
  expect(inPanel(app, "du -sh")).toBe(true);
  expect(hasContext(app)).toBe(false);
  expect(inPanel(app, "Clean the disk")).toBe(false);
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-worker");
  expect(inPanel(app, "compiled 3 files")).toBe(true);
  expect(app.shows("id:chat-detail-panel >> id:chat-detail-close")).toBe(true);
  expect(hasContext(app)).toBe(false);
  expect(inPanel(app, "Clean the disk")).toBe(false);
  expect(userMessageShown(app)).toBe(true);
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  // Back closes the workbench, not the topic.
  await app.back();
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  expect(app.shows("id:chat-back")).toBe(true);
  // The close in its head does too.
  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  // The workspace panel is still the right sheet, from the bar.
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
  expect(app.shows("id:chat-detail-panel")).toBe(false);
});

// The workbench goes out with what it showed (chatController's workbenchDetail), and closing the
// details never brings up the workspace panel. Headless runs do not draw the slide, so this checks
// only that the workspace panel never shows on the way out; the exit's look is not checked here.
test("on a phone the closing workbench keeps the details, never showing the workspace panel", async () => {
  const { app } = await openConsole({ platform: "android", location: CHAT, api: API });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  let workspaceShown = false;
  const watch = setInterval(() => {
    if (app.shows("id:chat-workspace-panel")) workspaceShown = true;
  }, 5);
  try {
    await app.press("id:chat-detail-close");
    expect(app.shows("id:chat-workspace-panel")).toBe(false);
    await app.waitFor("id:chat-detail-panel", { state: "gone" });
    await app.wait(400);
  } finally {
    clearInterval(watch);
  }
  expect(workspaceShown).toBe(false);
  expect(app.shows("id:chat-workspace-panel")).toBe(false);
  // The workspace sheet still opens alone afterwards.
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
  expect(app.shows("id:chat-detail-panel")).toBe(false);
});

/* ---------- the panel alone ---------- */

test("the open plan follows the reply as it changes, and says when there is nothing to show", async () => {
  const app = await open("./fixtures/activity-detail-app.tsx", { width: 600, height: 700, platform: "linux", locale: "en-US" });
  await app.waitFor("id:chat-detail-plan");
  expect(inPanel(app, "Look around")).toBe(true);
  expect(inPanel(app, "0/1")).toBe(true);
  // A step added while it is open shows at once, with the count.
  await app.press("id:add-step");
  await app.waitFor("id:chat-detail-panel >> text:Step 2");
  expect(inPanel(app, "1/2")).toBe(true);
  // A selection with nothing behind it: a reply without reasoning, a worker it does not have.
  await app.press("id:show-reasoning");
  await app.waitFor("id:chat-detail-panel >> text:Nothing to show yet.");
  expect(inPanel(app, "Reasoning")).toBe(true);
  await app.press("id:show-missing-worker");
  await app.waitFor("id:chat-detail-panel >> text:No output yet.");
  // Progress with nothing yet: the empty note under the head, no message above it.
  await app.press("id:show-activity");
  await app.waitFor("id:chat-detail-empty");
  expect(inPanel(app, "Progress")).toBe(true);
  expect(hasContext(app)).toBe(false);
  // A coder that wrote nothing yet: likewise, and a subagent keeps the message.
  await app.press("id:show-coder");
  await app.waitFor("id:chat-detail-worker");
  expect(inPanel(app, "Curie")).toBe(true);
  expect(inPanel(app, "Running…")).toBe(true);
  expect(hasContext(app)).toBe(false);
  await app.press("id:show-subagent");
  await app.waitUntil(() => inPanel(app, "Noether"));
  expect(inPanel(app, "Clean the disk")).toBe(true);
  // A failed reply: still none for progress or the coder.
  await app.press("id:fail");
  await app.press("id:show-coder");
  await app.waitUntil(() => inPanel(app, "Curie") && !hasContext(app));
  await app.press("id:show-activity");
  await app.waitUntil(() => inPanel(app, "Progress"));
  expect(app.shows("id:chat-detail-empty")).toBe(true);
  expect(hasContext(app)).toBe(false);
  // The reply gone from the history: the panel stays, empty, and its close still works.
  await app.press("id:drop-reply");
  await app.waitFor("id:chat-detail-panel >> text:Nothing to show yet.");
  await app.press("id:chat-detail-close");
  await app.waitFor("text:closed 1");
  // Escape closes it beside the conversation.
  await app.keyboard.press("escape");
  await app.waitFor("text:closed 2");
});
