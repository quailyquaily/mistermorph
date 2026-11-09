// The composer: commands as you type, the keys through sent messages, drafts per topic, attached
// files (upload, failure, retry, preview, removal), the model picker, and its add menu and model
// picker on phones, where they are sheets the software keyboard would cover.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { nextComposerRows, SINGLE_ROW } from "../components/chat/composerRows";
import { sheetKeyboardLift } from "../components/chat/composerSheets";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = {
  body: {
    items: [
      { id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW },
      { id: "topic-2", title: "Notes", created_at: NOW, updated_at: NOW },
    ],
  },
};

function history(request: ApiRequest) {
  if (request.uri?.includes("topic_id=topic-1")) {
    return {
      body: {
        items: [{ id: "t1", task: "Check the logs", topic_id: "topic-1", status: "done", created_at: NOW, finished_at: NOW, result: { final: { output: "Logs are fine." } } }],
      },
    };
  }
  return { body: { items: [] } };
}

const PICKED = { id: "f1", name: "notes.txt", size: 12, type: "text/plain", preview: "" };

test("a slash shows the agent's commands, and Enter puts the chosen one in the field", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": history,
      "GET /commands": { body: { items: [{ value: "/compact", title: "/compact", description: "Compact the context" }] } },
    },
  });
  await app.waitFor("text:Logs are fine.");
  await app.type("id:chat-composer-input", "/co");
  await app.waitFor("id:chat-composer-suggestions");
  await app.waitFor("Compact the context");
  expect(calls.some((call) => call.path === "/commands")).toBe(true);
  await app.submit("id:chat-composer-input");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "/compact ");
  await app.waitFor("id:chat-composer-suggestions", { state: "gone" });
});

test("Up brings back what was sent, and a draft stays with its topic", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": history },
  });
  await app.waitFor("text:Logs are fine.");
  await app.press("id:chat-composer-input");
  await app.keyboard.press("up");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Check the logs");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "half a thought");
  await app.press("id:chat-topic-topic-2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "");
  await app.press("id:chat-topic-topic-1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
});

test("files picked from the add menu upload, a failed one can be retried, and a ready one previews", async () => {
  let attempts = 0;
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": history,
      "GET /proxy/download:/files/download": { headers: { "content-type": "text/plain" }, body: "hello, file" },
    },
    host: {
      "morph.file.pick": [PICKED],
      "morph.file.upload": (data: any) => {
        attempts += 1;
        expect(data.field).toBe("files");
        expect(data.fields).toMatchObject({ topic_id: "topic-1" });
        return attempts === 1
          ? { ok: false, status: 500, statusText: "Internal Server Error", body: JSON.stringify({ error: "disk full" }) }
          : { ok: true, status: 200, statusText: "OK", body: JSON.stringify({ files: [{ name: "notes.txt", dir_name: "workspace_dir", path: "notes.txt" }] }) };
      },
      "morph.file.release": null,
    },
  });
  await app.waitFor("text:Logs are fine.");
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  await app.waitFor("id:chat-composer-files");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("disk full")));
  // The send waits while a file is not ready.
  await app.type("id:chat-composer-input", "see attached");
  expect(app.enabled("id:chat-composer-send")).toBe(false);
  await app.press("role:button[Retry upload]");
  await app.waitUntil(() => !app.texts().some((text) => text.startsWith("disk full")));
  expect(app.enabled("id:chat-composer-send")).toBe(true);
  await app.press("label:Preview file: notes.txt");
  await app.waitFor("id:chat-file-preview-text");
  await app.waitFor("hello, file");
});

test("the model picker lists the agent's profiles and the choice goes with the task", async () => {
  let body: any = null;
  const { app } = await openConsole({
    location: "/e/default/chat/topic-2",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": history,
      "GET /proxy:/llm/profiles": {
        body: { default: { model: "gpt-5.2", provider: "openai" }, items: [{ name: "cheap", model: "gpt-5-mini", provider: "openai" }] },
      },
      "POST /proxy:/tasks": (request: ApiRequest) => {
        body = request.json;
        return { status: 500, body: { error: "queue full" } };
      },
    },
  });
  await app.waitFor("id:chat-composer-profile");
  await app.press("label:LLM profile: Default");
  await app.press("text:cheap");
  await app.type("id:chat-composer-input", "hello");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => body !== null);
  expect(body.llm_profile).toBe("cheap");
  expect(body.topic_id).toBe("topic-2");
  // A send that fails keeps the text, and says why.
  await app.waitFor("queue full");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "hello");
});

test("the arrow keys move through the suggestions and Escape closes them", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-2",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": history,
      "GET /commands": {
        body: {
          items: [
            { value: "/alpha", title: "/alpha", description: "First" },
            { value: "/beta", title: "/beta", description: "Second" },
          ],
        },
      },
    },
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "/");
  await app.waitFor("Second");
  await app.keyboard.press("down");
  await app.keyboard.press("tab");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "/beta ");
  await app.type("id:chat-composer-input", "/");
  await app.waitFor("id:chat-composer-suggestions");
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-composer-suggestions", { state: "gone" });
});

// A line that wraps beside the controls but fits the wider field above them used to flip the
// layout on every layout pass (the field's height decided the rows, the rows its width), until a
// phone's page ran out of memory.
test("the field moves above the controls when its text wraps, and stays there while the line fits the wider field", () => {
  const line = "a line that wraps beside the buttons";
  const up = nextComposerRows(SINGLE_ROW, line, false);
  expect(up.multi).toBe(true);
  // Laid out again at the full width it is one line: no edit, so no move back.
  let rows = up;
  for (let pass = 0; pass < 10; pass += 1) rows = nextComposerRows(rows, line, true);
  expect(rows).toBe(up);
  // Typing on keeps it up.
  expect(nextComposerRows(up, `${line} and more`, true).multi).toBe(true);
});

test("the field comes back down once the text is shorter than when it moved up, or empty", () => {
  const up = nextComposerRows(SINGLE_ROW, "a line that wraps beside the buttons", false);
  expect(nextComposerRows(up, "a line that wraps", true)).toEqual(SINGLE_ROW);
  expect(nextComposerRows(up, "", true)).toEqual(SINGLE_ROW);
  // Shorter but still more than one line at the full width, or holding a line break: it stays up.
  expect(nextComposerRows(up, "a line that wraps", false).multi).toBe(true);
  expect(nextComposerRows(up, "one\ntwo", true).multi).toBe(true);
  // A line break moves it up from one row too.
  const broken = nextComposerRows(SINGLE_ROW, "one\n", false);
  expect(broken.multi).toBe(true);
  expect(nextComposerRows(broken, "one", true)).toEqual(SINGLE_ROW);
});

// On phones the add menu and the model picker are sheets at the bottom of the screen, under the
// software keyboard the focused field keeps up (Android shrinks neither the surface nor an overlay
// for it). Headless engines draw no keyboard: it is up while the field has the focus, which a
// hardware key shows (it types into the focused field, and nowhere without one).
const PROFILES = {
  body: { default: { model: "gpt-5.2", provider: "openai" }, items: [{ name: "cheap", model: "gpt-5-mini", provider: "openai" }] },
};
/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };

async function openPhoneChat(post?: (request: ApiRequest) => { status: number; body: unknown }) {
  return openConsole({
    platform: "android",
    safeArea: BARS,
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/todo/tasks": { body: { items: [] } },
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/llm/profiles": PROFILES,
      ...(post ? { "POST /proxy:/tasks": post } : {}),
    },
  });
}

/** Whether the field has the focus (the keyboard is up): a key typed lands in it. */
async function fieldFocused(app: App) {
  const before = app.value("id:chat-composer-input") ?? "";
  await app.keyboard.press("`");
  const after = app.value("id:chat-composer-input") ?? "";
  if (after === before) return false;
  // Take the probe back out.
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.value("id:chat-composer-input") === before);
  return true;
}

test("on a phone the add menu lowers the keyboard, and closing it gives the field back with its draft", async () => {
  const { app } = await openPhoneChat();
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "half a thought");
  expect(await fieldFocused(app)).toBe(true);

  await app.press("id:chat-composer-add");
  await app.waitFor("text:Upload Files");
  await app.waitFor("text:Attach Workspace");
  expect(await fieldFocused(app)).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("half a thought");

  // Closed without a choice (Back): the field has the focus again, the caret after the text.
  await app.back();
  await app.waitFor("text:Upload Files", { state: "gone" });
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  await app.keyboard.press("shift+1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought!");

  // Upload goes on to the photo picker: the keyboard stays down, the draft stays.
  await app.press("id:chat-composer-add");
  await app.press("text:Upload Files");
  await app.waitUntil(() => app.picks().length === 1);
  expect(await fieldFocused(app)).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("half a thought!");
});

test("on a phone the model picker lowers the keyboard, and typing goes on after a model is chosen", async () => {
  let body: any = null;
  const { app } = await openPhoneChat((request) => {
    body = request.json;
    return { status: 500, body: { error: "queue full" } };
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "hello");
  await app.waitFor("label:LLM profile: Default");

  await app.press("label:LLM profile: Default");
  await app.waitFor("text:gpt-5-mini");
  // The sheet's search field is not focused: nothing raises the keyboard over the sheet.
  expect(await fieldFocused(app)).toBe(false);
  expect(app.value("text:Filter")).toBe("");

  await app.press("text:cheap");
  await app.waitFor("text:gpt-5-mini", { state: "gone" });
  await app.keyboard.press("shift+1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "hello!");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => body !== null);
  expect(body.llm_profile).toBe("cheap");
  expect(body.task).toBe("hello!");

  // Cancelled (Back) also gives the field back.
  await app.waitFor("queue full");
  await app.press("label:LLM profile: cheap");
  await app.waitFor("text:gpt-5-mini");
  expect(await fieldFocused(app)).toBe(false);
  await app.back();
  await app.waitFor("text:gpt-5-mini", { state: "gone" });
  expect(await fieldFocused(app)).toBe(true);
});

test("on a phone with the keyboard down the sheets open and close as before, leaving it down", async () => {
  const { app } = await openPhoneChat();
  await app.waitFor("label:LLM profile: Default");
  expect(await fieldFocused(app)).toBe(false);

  await app.press("id:chat-composer-add");
  await app.waitFor("text:Attach Workspace");
  await app.back();
  await app.waitFor("text:Attach Workspace", { state: "gone" });
  expect(await fieldFocused(app)).toBe(false);

  await app.press("label:LLM profile: Default");
  await app.press("text:cheap");
  await app.waitFor("label:LLM profile: cheap");
  expect(await fieldFocused(app)).toBe(false);
  // The field takes a tap as before.
  await app.press("id:chat-composer-input");
  expect(await fieldFocused(app)).toBe(true);
});

test("on the desktop the add menu and the model picker leave the field focused", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": history, "GET /proxy:/llm/profiles": PROFILES },
  });
  await app.waitFor("text:Logs are fine.");
  await app.type("id:chat-composer-input", "draft");
  await app.press("id:chat-composer-add");
  await app.waitFor("text:Upload Files");
  expect(await fieldFocused(app)).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("text:Upload Files", { state: "gone" });
  await app.press("label:LLM profile: Default");
  await app.press("text:cheap");
  await app.waitFor("label:LLM profile: cheap");
  expect(await fieldFocused(app)).toBe(true);
  expect(app.value("id:chat-composer-input")).toBe("draft");
});

test("the model picker's sheet rises above a keyboard its search field raised, within the screen", () => {
  // Hidden: nsh places the sheet (its own room for the navigation bar).
  expect(sheetKeyboardLift(0, 24, 844, 320)).toBeUndefined();
  expect(sheetKeyboardLift(Number.NaN, 24, 844, 320)).toBeUndefined();
  // Up on a phone: the keyboard's height under the sheet (it covers the navigation bar), the list
  // as tall as on the desktops above it.
  expect(sheetKeyboardLift(300, 24, 844, 320)).toEqual({ paddingBottom: 300, maxHeight: 620 });
  // A phone on its side: the list keeps to the room between the status bar and the keyboard.
  expect(sheetKeyboardLift(200, 24, 390, 320)).toEqual({ paddingBottom: 200, maxHeight: 366 });
  // No room at all: the list gets none rather than a negative height.
  expect(sheetKeyboardLift(500, 24, 390, 320)).toEqual({ paddingBottom: 500, maxHeight: 500 });
});
