// A coder's output in the detail panel is drawn on the same dark terminal as the reply's progress
// (components/chat/ChatTerminal.tsx): the same surface, and the same text styles for what was
// printed, errors, labels and the empty state. Headless runs cannot read a view's background, so
// the surface is the shared `chat-terminal` view and the text is compared by its resolved style.
import { expect, test, type App } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

const TASK = {
  id: "t1",
  task: "Build the site",
  topic_id: "topic-1",
  created_at: NOW,
  started_at: NOW,
  status: "running",
  result: {
    activity: {
      history: [
        { id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: "make" }, output: "progress printed this", at: NOW },
        { id: "a2", kind: "tool", name: "read_file", status: "failed", error: "progress failed here" },
      ],
      workers: [
        {
          id: "w1",
          name: "Curie",
          name_index: 1,
          avatar_index: 0,
          kind: "coder",
          status: "running",
          output: "coder printed this",
          processes: [{ pid: 4242, program: "codex" }],
        },
        { id: "w2", name: "Hopper", name_index: 2, avatar_index: 1, kind: "coder", status: "running" },
        { id: "w3", name: "Lovelace", name_index: 3, avatar_index: 2, kind: "coder", status: "failed", error: "coder failed here", output: "half done" },
      ],
    },
  },
};

const API = {
  "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } },
  "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [TASK] : [] } }),
  "GET /proxy:/tasks/t1": { body: TASK },
  "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
};

const TERMINAL = {
  note: "#e8eef5d1",
  muted: "#d5e0ecb2",
  error: "#e08a9e",
};

function style(app: App, selector: string) {
  const { color, fontSize, fontWeight, italic } = app.spanStyle(selector);
  return { color: color.toLowerCase(), fontSize, fontWeight, italic };
}

async function openWorker(app: App, label: string) {
  await app.press(`label:${label}`);
  await app.waitFor("id:chat-detail-worker >> id:chat-terminal >> id:chat-worker-output");
}

test("a coder's output, empty output and error are drawn on the progress terminal in its text styles", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: API });
  await app.waitFor("id:chat-status-card");

  // Progress: the reference.
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity >> id:chat-terminal");
  const printed = style(app, "id:chat-terminal >> text:progress printed this");
  const failed = style(app, "id:chat-terminal >> text:progress failed here");
  const label = style(app, "id:chat-terminal >> text:TOOL >> nth=0");
  expect(printed.color).toBe(TERMINAL.note);
  expect(failed.color.slice(0, 7)).toBe(TERMINAL.error);
  expect(label.color).toBe(TERMINAL.muted);

  // A coder with output: on the terminal, its output styled as progress's printed output, its
  // kind as progress's kind label; its PID still there.
  await openWorker(app, "Curie · Coder · Running");
  expect(app.count("id:chat-detail-panel >> id:chat-terminal")).toBe(1);
  expect(style(app, "id:chat-terminal >> text:coder printed this")).toEqual(printed);
  expect(style(app, "id:chat-terminal >> text:CODER")).toEqual(label);
  expect(style(app, "id:chat-terminal >> text:codex PID 4242").color).toBe(TERMINAL.muted);
  // One section: no heading.
  expect(app.shows("id:chat-terminal >> text:OUTPUT")).toBe(false);

  // A coder with nothing printed yet: the empty line, on the terminal, in its muted text.
  await openWorker(app, "Hopper · Coder · Running");
  expect(style(app, "id:chat-terminal >> text:No output yet.").color).toBe(TERMINAL.muted);

  // A failed coder: its error in progress's error style, then its output, each under a heading
  // styled as progress's labels.
  await openWorker(app, "Lovelace · Coder · Failed");
  expect(style(app, "id:chat-terminal >> text:coder failed here")).toEqual(failed);
  expect(style(app, "id:chat-terminal >> text:half done")).toEqual(printed);
  expect(style(app, "id:chat-terminal >> text:ERROR")).toEqual(label);
  expect(style(app, "id:chat-terminal >> text:OUTPUT")).toEqual(label);
  expect(app.shows("id:chat-worker-output >> text:FAILED")).toBe(true);
});
