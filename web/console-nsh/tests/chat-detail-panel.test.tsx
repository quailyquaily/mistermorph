// The temporary detail panel at the right of the conversation: a reply's plan, progress, reasoning
// and workers open there (never inside the conversation), one at a time; it and the topic and
// workspace panel replace each other; close, Escape and Back dismiss it; another conversation
// closes it; and what still streams keeps growing in it. Progress and a coder's output never repeat
// the message the reply answers at their top; the conversation keeps it.
import { batch, effect, signal, untracked } from "nsh";
import { expect, open, test, type App } from "nsh/test";
import { createFocusReturn } from "../components/chat/activityDetail";
import { localEndpoint, openConsole, type ApiRequest } from "./harness";

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
  expect(inPanel(app, "Clean the disk")).toBe(true);

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
test("Escape closes the agent menu opened over the panel before the panel", async () => {
  const { app } = await openChat();
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("label:Overview");
  await app.keyboard.press("escape");
  await app.wait(300);
  expect(app.shows("id:chat-detail-panel")).toBe(true);
});

test("Escape is the agent dialog's, opened over the panel from outside the chat page", async () => {
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
  // (Headless, Escape never reaches nsh's dialog itself: only that the panel leaves it alone.)
  await app.keyboard.press("escape");
  await app.wait(300);
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

test("the detail panel and the workspace panel replace each other, both ways", async () => {
  const { app } = await openChat({ kv: PANEL_OPEN });
  await app.waitFor("id:chat-workspace-panel");
  // The detail panel takes the workspace panel's place.
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
  expect(app.shows("id:chat-workspace-panel")).toBe(false);
  expect(app.count("id:chat-right-panel")).toBe(1);
  // The workspace toggle (over the conversation now) brings the workspace panel back in its place.
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
  expect(app.shows("id:chat-detail-panel")).toBe(false);
  expect(app.count("id:chat-right-panel")).toBe(1);
  // And a worker replaces it again.
  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-panel");
  expect(app.shows("id:chat-workspace-panel")).toBe(false);
  // Closing the details leaves no panel; the workspace panel stays remembered as open for next time.
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  expect(app.shows("id:chat-workspace-panel")).toBe(false);
  expect(app.shows("id:chat-right-panel")).toBe(false);
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

test("on a phone the details open in the right sheet, and Back closes it to the conversation", async () => {
  const { app } = await openConsole({ platform: "android", location: CHAT, api: API });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-plan");
  await app.waitFor("id:chat-detail-panel");
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
  // Back closes the sheet, not the topic.
  await app.back();
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  expect(app.shows("id:chat-back")).toBe(true);
  // The close in its head does too.
  await app.press("label:Curie · Coder · Done");
  await app.waitFor("id:chat-detail-panel");
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  // The workspace sheet still opens from the bar, alone.
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
  expect(app.shows("id:chat-detail-panel")).toBe(false);
});

// The sheet goes out with what it showed: closing the details does not put the workspace panel
// (or its narrower width) in the sheet under its exit (chatController's mobileSheetDetail).
// Headless runs do not draw the sheet's exit, so this checks only that the workspace panel never
// shows on the way out; the exit's look is not checked here.
test("on a phone the closing sheet keeps the details, never showing the workspace panel", async () => {
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
  expect(inPanel(app, "No output yet.")).toBe(true);
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
