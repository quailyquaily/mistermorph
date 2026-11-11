// The composer: commands as you type, the keys through sent messages, drafts per topic, attached
// files (upload, failure, retry, preview, removal), the model picker, and its add menu and model
// picker on phones, where they are sheets the software keyboard would cover, and the phone bar's
// back arrow, whose first tap with the keyboard up only lowers it.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { LayoutAnimation, signal } from "nsh";
import { COMPOSER_LINE_HEIGHT } from "../components/chat/composerField";
import { composerLayout, followComposerLayout, ONE_ROW, type ComposerLayout } from "../components/chat/composerRows";
import { PROFILE_SHEET_MAX_HEIGHT, PROFILE_SHEET_PADDING } from "../components/chat/composerSheets";
import { softKeyboardUp } from "../lib/softKeyboard";
import { bottomSheetInsets } from "../lib/systemInsets";
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
// phone's page ran out of memory; the next fix kept the one-row width above the controls, a narrow
// field in the two-row layout. The rows now come from the draft's height beside the controls, which
// the rows do not change, and two rows are always the full width (composerRows.ts).
const LINE = COMPOSER_LINE_HEIGHT;
/** The copies' heights for `text`; `settled`: both have laid it out (ComposerMeasure's two frames). */
const measured = (text: string, oneRow: number, twoRows: number, settled = true) => ({ oneRow, twoRows, text, settled });
const TWO = (height: number): ComposerLayout => ({ rows: "two", height });

test("one line beside the controls is one row, whatever the wider field would hold", () => {
  expect(composerLayout("hello", measured("hello", LINE, LINE))).toEqual({ rows: "one", height: LINE });
  // A line measured a little taller is still one line.
  expect(composerLayout("hello", measured("hello", LINE + 3, LINE + 3)).rows).toBe("one");
});

test("a line that wraps beside the controls is two rows at once, as tall as it is across the row, even one line", () => {
  const text = "a line that wraps beside the buttons";
  const layout = composerLayout(text, measured(text, 2 * LINE, LINE));
  expect(layout).toEqual(TWO(LINE));
  // Laid out again (the field above the controls now), the measures are the same: so is the layout.
  for (let pass = 0; pass < 10; pass += 1) expect(composerLayout(text, measured(text, 2 * LINE, LINE), layout)).toEqual(layout);
  // Longer, it grows across the row.
  expect(composerLayout("a long draft", measured("a long draft", 3 * LINE, 2 * LINE))).toEqual(TWO(2 * LINE));
});

test("a line break is two rows of two lines at least, measured or not", () => {
  expect(composerLayout("one\ntwo", measured("one\ntwo", 2 * LINE, 2 * LINE))).toEqual(TWO(2 * LINE));
  // Headless engines measure a break as no break.
  expect(composerLayout("hi\n", measured("hi\n", LINE, LINE))).toEqual(TWO(2 * LINE));
  expect(composerLayout("one\ntwo\nthree", measured("one\ntwo\nthree", 3 * LINE, 3 * LINE))).toEqual(TWO(3 * LINE));
  // Typed before the copies have laid it out: two rows at once, no shorter than before.
  expect(composerLayout("hi\n", measured("hi", LINE, LINE), ONE_ROW)).toEqual(TWO(2 * LINE));
  expect(composerLayout("a long draft\n", measured("a long draft", 3 * LINE, 3 * LINE), TWO(3 * LINE))).toEqual(TWO(3 * LINE));
});

test("a draft the copies have not measured yet keeps the layout it has, so it moves once, when they have", () => {
  // Nothing measured yet (a draft restored on opening): one row until the copies report.
  expect(composerLayout("a restored draft", { oneRow: LINE, twoRows: LINE, text: null, settled: false }, ONE_ROW)).toEqual(ONE_ROW);
  // A long draft replaced by a short one in one edit: the copies' heights are the long draft's.
  expect(composerLayout("hi", measured("a long draft", 5 * LINE, 4 * LINE), ONE_ROW)).toEqual(ONE_ROW);
  expect(composerLayout("hi", measured("a long draft", 5 * LINE, 4 * LINE), TWO(4 * LINE))).toEqual(TWO(4 * LINE));
  // A short draft replaced by a long one: one row until measured, then two rows in one move.
  expect(composerLayout("a long draft", measured("hi", LINE, LINE), ONE_ROW)).toEqual(ONE_ROW);
  expect(composerLayout("a long draft", measured("a long draft", 5 * LINE, 4 * LINE), ONE_ROW)).toEqual(TWO(4 * LINE));
});

test("the way back is the way there: the same draft and widths give the same layout, and empty is one row", () => {
  for (const [oneRow, twoRows] of [
    [LINE, LINE],
    [2 * LINE, LINE],
    [3 * LINE, 2 * LINE],
  ]) {
    const there = composerLayout("draft", measured("draft", oneRow, twoRows), ONE_ROW);
    expect(composerLayout("draft", measured("draft", oneRow, twoRows), TWO(9 * LINE))).toEqual(there);
  }
  // Cleared or sent: one row at once, before the copies have measured the empty field.
  expect(composerLayout("", measured("a long draft", 5 * LINE, 4 * LINE), TWO(4 * LINE))).toEqual(ONE_ROW);
});

/** followComposerLayout over a draft and its measures, with LayoutAnimation.configureNext counted
 *  and display frames run by hand (`frames`), from a two-row layout settled for `draft`. */
function followed(draft: string, height: number) {
  const ease = LayoutAnimation.configureNext;
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  let eased = 0;
  let queued = new Map<number, () => void>();
  let id = 0;
  (LayoutAnimation as { configureNext: unknown }).configureNext = () => {
    eased += 1;
  };
  globalThis.requestAnimationFrame = (run: (time: number) => void) => {
    id += 1;
    queued.set(id, () => run(0));
    return id;
  };
  globalThis.cancelAnimationFrame = (frame?: number) => void queued.delete(frame ?? 0);
  const layout = signal<ComposerLayout>(ONE_ROW);
  const text = signal(draft);
  const measures = signal(measured(draft, height + LINE, height));
  followComposerLayout(layout, text, measures);
  const frames = () => {
    for (let frame = 0; frame < 4; frame += 1) {
      const due = queued;
      queued = new Map();
      for (const run of due.values()) run();
    }
  };
  frames();
  expect(layout()).toEqual(TWO(height));
  eased = 0;
  return {
    layout,
    text,
    measures,
    frames,
    eased: () => eased,
    restore() {
      (LayoutAnimation as { configureNext: unknown }).configureNext = ease;
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = caf;
    },
  };
}

test("above the controls a resize snaps the height, even right after an edit that kept it", () => {
  const composer = followed("a long draft", 2 * LINE);
  try {
    // A character that leaves both heights as they were, measured for the new draft.
    composer.text.set("a long draft!");
    composer.measures.set(measured("a long draft!", 3 * LINE, 2 * LINE));
    expect(composer.layout()).toEqual(TWO(2 * LINE));
    // The window narrows: the same draft is a line taller across the row. A new width, not an edit.
    composer.measures.set(measured("a long draft!", 4 * LINE, 3 * LINE));
    expect(composer.layout()).toEqual(TWO(3 * LINE));
    expect(composer.eased()).toBe(0);
  } finally {
    composer.restore();
  }
});

test("above the controls an edit's height eases once measured, past the earlier draft's measures", () => {
  const composer = followed("a long draft", 2 * LINE);
  try {
    // Typed: the copies' heights are still the earlier draft's, so nothing moves yet.
    composer.text.set("a long draft that grows");
    expect(composer.measures().text).toBe("a long draft");
    expect(composer.layout()).toEqual(TWO(2 * LINE));
    // The copies report the new draft a line taller: that height is the edit's, and eases.
    composer.measures.set(measured("a long draft that grows", 4 * LINE, 3 * LINE));
    expect(composer.layout()).toEqual(TWO(3 * LINE));
    expect(composer.eased()).toBe(1);
  } finally {
    composer.restore();
  }
});

test("above the controls an edit's height eases when the copies report it one after the other", () => {
  const composer = followed("a long draft", 2 * LINE);
  try {
    // Pasted: the one-row copy reports the new draft first, a line taller beside the controls, while
    // the full-width copy has not laid it out yet. The layout it gives is the one shown.
    composer.text.set("a long draft that grows");
    composer.measures.set(measured("a long draft that grows", 4 * LINE, 2 * LINE, false));
    expect(composer.layout()).toEqual(TWO(2 * LINE));
    // Then the full-width copy: the edit's height, which eases as one that both report at once does.
    composer.measures.set(measured("a long draft that grows", 4 * LINE, 3 * LINE, false));
    expect(composer.layout()).toEqual(TWO(3 * LINE));
    expect(composer.eased()).toBe(1);
    // Settled, a resize after it snaps.
    composer.measures.set(measured("a long draft that grows", 4 * LINE, 3 * LINE));
    composer.measures.set(measured("a long draft that grows", 5 * LINE, 4 * LINE));
    expect(composer.layout()).toEqual(TWO(4 * LINE));
    expect(composer.eased()).toBe(1);
  } finally {
    composer.restore();
  }
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

  // Send lowered the keyboard. A tap raises it again; then a cancelled (Back) picker also gives the
  // field back.
  await app.waitFor("queue full");
  expect(await fieldFocused(app)).toBe(false);
  await app.press("id:chat-composer-input");
  expect(await fieldFocused(app)).toBe(true);
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

// Headless runs have no software keyboard and report no keyboard frame: a headless Android phone
// whose field has the focus is one typing on a hardware keyboard, and the Android app trusts the
// frame from the start (lib/softKeyboard.ts). Nothing covers the view, so the first tap goes back.
// (The arrow's first tap lowering a keyboard the frame reports is the table's, below.)
test("on a phone with a hardware keyboard the back arrow goes to the topic list on the first tap", async () => {
  const { app } = await openPhoneChat();
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "half a thought");
  expect(await fieldFocused(app)).toBe(true);

  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  expect(app.shows("id:chat-back")).toBe(false);

  // The topic keeps its draft, and opening it again does not focus the field.
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-back");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  expect(await fieldFocused(app)).toBe(false);
});

test("on a phone with the keyboard down the back arrow goes to the topic list at once", async () => {
  const { app } = await openPhoneChat();
  await app.waitFor("id:chat-composer-input");
  expect(await fieldFocused(app)).toBe(false);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  expect(app.shows("id:chat-back")).toBe(false);
});

test("in a narrow desktop window the back arrow goes to the topic list with the field focused", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    width: 390,
    height: 844,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": history, "GET /proxy:/llm/profiles": PROFILES },
  });
  await app.waitFor("text:Logs are fine.");
  await app.type("id:chat-composer-input", "draft");
  expect(await fieldFocused(app)).toBe(true);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  expect(app.shows("id:chat-back")).toBe(false);
});

test("the software keyboard is up by its frame, or on the web by the focused field until a frame reports one", () => {
  const cases: {
    name: string;
    desktop?: boolean;
    frameNative?: boolean;
    height: number;
    frameReported: boolean;
    fieldFocused: boolean;
    up: boolean;
  }[] = [
    { name: "Android: a keyboard frame", frameNative: true, height: 300, frameReported: true, fieldFocused: true, up: true },
    { name: "Android: a keyboard frame before any reported", frameNative: true, height: 300, frameReported: false, fieldFocused: true, up: true },
    { name: "Android: a keyboard still going down", frameNative: true, height: 120, frameReported: true, fieldFocused: false, up: true },
    { name: "Android: a hardware keyboard from the start", frameNative: true, height: 0, frameReported: false, fieldFocused: true, up: false },
    { name: "Android: a hardware keyboard after a software one", frameNative: true, height: 0, frameReported: true, fieldFocused: true, up: false },
    { name: "Android: nothing focused", frameNative: true, height: 0, frameReported: false, fieldFocused: false, up: false },
    { name: "web: a keyboard frame", height: 300, frameReported: true, fieldFocused: true, up: true },
    { name: "web: a keyboard frame still going down, the field already unfocused", height: 120, frameReported: true, fieldFocused: false, up: true },
    { name: "web: no frame after frames reported: a hardware keyboard", height: 0, frameReported: true, fieldFocused: true, up: false },
    { name: "web: no frame reported yet, the field focused", height: 0, frameReported: false, fieldFocused: true, up: true },
    { name: "web: no frame reported yet, the field unfocused", height: 0, frameReported: false, fieldFocused: false, up: false },
    { name: "a desktop", desktop: true, height: 0, frameReported: false, fieldFocused: true, up: false },
  ];
  for (const item of cases) {
    const { name, up, desktop = false, frameNative = false, ...state } = item;
    expect({ name, up: softKeyboardUp({ desktop, frameNative, ...state }) }).toEqual({ name, up });
  }
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

// Send on a phone lowers the keyboard as the message goes, once, and keeps what a failed send keeps.
test("on a phone Send lowers the keyboard and sends once; a failed send keeps the draft", async () => {
  const bodies: any[] = [];
  const { app } = await openPhoneChat((request) => {
    bodies.push(request.json);
    return { status: 500, body: { error: "queue full" } };
  });
  await app.waitFor("id:chat-composer-input");
  // Nothing to send: Send is disabled, and the keyboard stays up.
  await app.press("id:chat-composer-input");
  expect(app.enabled("id:chat-composer-send")).toBe(false);
  expect(await fieldFocused(app)).toBe(true);

  await app.type("id:chat-composer-input", "hello");
  expect(await fieldFocused(app)).toBe(true);
  await app.press("id:chat-composer-send");
  await app.waitFor("queue full");
  expect(bodies.map((body) => body.task)).toEqual(["hello"]);
  await app.waitUntil(() => app.value("id:chat-composer-input") === "hello");
  expect(await fieldFocused(app)).toBe(false);

  // With the keyboard already down, Send sends again and leaves it down.
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => bodies.length === 2);
  expect(bodies[1].task).toBe("hello");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.waitUntil(() => app.value("id:chat-composer-input") === "hello");
  expect(await fieldFocused(app)).toBe(false);
});

test("on a phone a sent message clears the field with the keyboard down, and Stop leaves the keyboard alone", async () => {
  let posts = 0;
  let stops = 0;
  const { app } = await openConsole({
    platform: "android",
    safeArea: BARS,
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/todo/tasks": { body: { items: [] } },
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/llm/profiles": PROFILES,
      "POST /proxy:/tasks": () => {
        posts += 1;
        return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
      "GET /proxy:/tasks/task-1": { body: { id: "task-1", task: "Hello there", status: "running", topic_id: "topic-1", created_at: NOW } },
      "POST /proxy:/tasks/task-1/stop": () => {
        stops += 1;
        return { body: { ok: true } };
      },
    },
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "Hello there");
  await app.press("id:chat-composer-send");
  await app.waitFor("Hello there");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "");
  expect(posts).toBe(1);
  expect(await fieldFocused(app)).toBe(false);

  // While the reply runs Send is Stop: it stops the task and leaves a raised keyboard up.
  await app.waitFor("label:Stop Task");
  await app.press("id:chat-composer-input");
  expect(await fieldFocused(app)).toBe(true);
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => stops === 1);
  expect(posts).toBe(1);
  expect(await fieldFocused(app)).toBe(true);
});

// A wide touch screen (a tablet, 1280 wide) lays the chat out as a desktop does, but Send still
// lowers the keyboard: the send that follows must not raise it again, whether it fails or succeeds.
test("on a wide touch screen Send lowers the keyboard and the send does not raise it again", async () => {
  const bodies: any[] = [];
  let fail = true;
  const { app } = await openConsole({
    platform: "android",
    width: 1280,
    height: 800,
    safeArea: BARS,
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/todo/tasks": { body: { items: [] } },
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/llm/profiles": PROFILES,
      "POST /proxy:/tasks": (request: ApiRequest) => {
        bodies.push(request.json);
        if (fail) return { status: 500, body: { error: "queue full" } };
        return { status: 200, body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
      "GET /proxy:/tasks/task-1": { body: { id: "task-1", task: "hello", status: "running", topic_id: "topic-1", created_at: NOW } },
    },
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "hello");
  expect(await fieldFocused(app)).toBe(true);
  await app.press("id:chat-composer-send");
  await app.waitFor("queue full");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  expect(bodies.map((body) => body.task)).toEqual(["hello"]);
  expect(app.value("id:chat-composer-input")).toBe("hello");
  expect(await fieldFocused(app)).toBe(false);

  fail = false;
  await app.press("id:chat-composer-input");
  expect(await fieldFocused(app)).toBe(true);
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  expect(bodies.map((body) => body.task)).toEqual(["hello", "hello"]);
  expect(await fieldFocused(app)).toBe(false);
});

test("on the desktop Send leaves the field focused", async () => {
  const bodies: any[] = [];
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": history,
      "POST /proxy:/tasks": (request: ApiRequest) => {
        bodies.push(request.json);
        return { status: 500, body: { error: "queue full" } };
      },
    },
  });
  await app.waitFor("text:Logs are fine.");
  await app.type("id:chat-composer-input", "draft");
  await app.press("id:chat-composer-send");
  await app.waitFor("queue full");
  expect(bodies.map((body) => body.task)).toEqual(["draft"]);
  await app.waitUntil(() => app.value("id:chat-composer-input") === "draft");
  expect(await fieldFocused(app)).toBe(true);
});

test("the model picker's sheet rises above a keyboard its search field raised, within the screen", () => {
  const lift = (keyboard: number, area: { top: number; bottom: number }, height: number) =>
    bottomSheetInsets(area, keyboard, height, PROFILE_SHEET_PADDING, PROFILE_SHEET_MAX_HEIGHT);
  // Hidden, no bars: the sheet is as its classes draw it.
  expect(lift(0, { top: 24, bottom: 0 }, 844)).toBeUndefined();
  expect(lift(Number.NaN, { top: 24, bottom: 0 }, 844)).toBeUndefined();
  // Hidden over a 16pt gesture handle: its 4pt padding above the handle, its list as tall as before.
  expect(lift(0, { top: 24, bottom: 16 }, 844)).toEqual({ paddingBottom: 20, maxHeight: 336 });
  // Up on a phone: the keyboard's height under the sheet (it covers the navigation bar: not both),
  // its 4pt padding, the list as tall as on the desktops above it.
  expect(lift(300, { top: 24, bottom: 0 }, 844)).toEqual({ paddingBottom: 304, maxHeight: 620 });
  expect(lift(300, { top: 24, bottom: 16 }, 844)).toEqual({ paddingBottom: 304, maxHeight: 620 });
  // A phone on its side: the list keeps to the room between the status bar and the keyboard.
  expect(lift(200, { top: 24, bottom: 16 }, 390)).toEqual({ paddingBottom: 204, maxHeight: 366 });
  // No room at all: the list gets none rather than a negative height.
  expect(lift(500, { top: 24, bottom: 16 }, 390)).toEqual({ paddingBottom: 504, maxHeight: 500 });
});
