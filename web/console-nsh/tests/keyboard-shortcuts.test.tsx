// Keyboard shortcuts in the Console (lib/shortcuts.ts, components/frame/shortcutDispatch.ts,
// components/settings/ShortcutsPanel.tsx): the Settings list with the keys in effect, recording,
// removing and restoring keys, refused and conflicting keys, saving per environment, and the
// shortcuts themselves: once per press, never under a dialog or while recording, only where their
// action is, and never taking typing keys from a text field. Headless `keyboard.press` matches
// the app's keymap as a hardware keyboard does (with the focused text field's rules); keys an
// input method is composing never match on the web (nsh's runtime skips `isComposing` keys), which
// no headless step can stage.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openConsole, type ApiHandler, type ConsoleOptions } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
const CHAT_API: Record<string, ApiHandler> = { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": EMPTY, "GET /proxy:/todo/tasks": EMPTY };
const WEB_KEY = "mistermorph.shortcuts.web";
const DESKTOP_KEY = "mistermorph.shortcuts.desktop";

/** The values the app saved through the host, last write first wins. */
function savedValue(app: App, key: string): string | null | undefined {
  const writes = app.host.calls().filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === key);
  return writes.length ? ((writes.at(-1)!.data as any).value as string | null) : undefined;
}
/** The last location the app wrote to the address bar. */
function lastLocation(app: App) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String((writes.at(-1)?.data as any)?.url || "");
}
/** The row of action `id` (`chat-newTopic`) shows `keys`. */
const showsKeys = (app: App, id: string, keys: string) => app.shows(`id:shortcut-keys-${id} >> text:${keys}`);
/** What a typed probe key does: whether it lands in the input `selector` names (it has the focus). */
async function focusedInput(app: App, selector: string) {
  const before = app.value(selector) ?? "";
  await app.keyboard.press("`");
  return (app.value(selector) ?? "") === `${before}\``;
}

async function openShortcuts(options: ConsoleOptions = {}) {
  const opened = await openConsole({ location: "/e/default/settings/shortcuts", ...options });
  await opened.app.waitFor("id:settings-shortcuts");
  return opened;
}

test("Settings lists every action with the browser's keys, and the desktop app's in the app", async () => {
  const { app } = await openShortcuts();
  expect(showsKeys(app, "chat-newTopic", "Ctrl+Shift+O")).toBe(true);
  expect(showsKeys(app, "chat-searchTopics", "Ctrl+K")).toBe(true);
  expect(showsKeys(app, "nav-contacts", "Alt+Shift+2")).toBe(true);
  expect(showsKeys(app, "help-shortcuts", "Shift+/")).toBe(true);
  expect(app.texts()).toContain("Go to Contacts");
  expect(app.texts()).toContain("For the Console in this browser. The desktop app keeps its own shortcuts.");
  expect(app.shows("id:shortcut-row-chat-newTopic >> text:Default")).toBe(true);
  // Alt+Shift with a digit types on some keyboards: the row says it acts outside text fields.
  expect(app.shows("id:shortcut-issue-nav-contacts")).toBe(true);
  expect(app.enabled("id:shortcuts-reset-all")).toBe(false);

  const desktop = await openShortcuts({ runtime: "desktop" });
  expect(showsKeys(desktop.app, "chat-newTopic", "Ctrl+N")).toBe(true);
  expect(showsKeys(desktop.app, "nav-contacts", "Ctrl+2")).toBe(true);
  expect(desktop.app.texts()).toContain("For this app. The Console in a browser keeps its own shortcuts.");
});

test("on a Mac the keys show with Apple's symbols and Command", async () => {
  const { app } = await openShortcuts({ runtime: "desktop", os: "macos" });
  expect(showsKeys(app, "chat-newTopic", "⌘N")).toBe(true);
  expect(showsKeys(app, "nav-settings", "⌘,")).toBe(true);
  const web = await openShortcuts({ os: "macos" });
  expect(showsKeys(web.app, "chat-newTopic", "⇧⌘O")).toBe(true);
});

test("recording new keys saves them for this environment only, and they last a restart", async () => {
  const { app } = await openShortcuts();
  await app.press("id:shortcut-change-chat-newTopic");
  await app.waitFor("id:shortcut-recording-chat-newTopic");
  await app.keyboard.press("ctrl+shift+y");
  await app.waitFor("id:shortcut-recording-chat-newTopic", { state: "gone" });
  expect(showsKeys(app, "chat-newTopic", "Ctrl+Shift+Y")).toBe(true);
  expect(app.shows("id:shortcut-row-chat-newTopic >> text:Changed")).toBe(true);
  const saved = savedValue(app, WEB_KEY);
  expect(JSON.parse(String(saved))).toEqual({ version: 1, bindings: { "chat.newTopic": "ctrl+shift+y" } });
  expect(savedValue(app, DESKTOP_KEY)).toBe(undefined);

  // Reopened with what it saved: the change is there, and the desktop app's keys are untouched.
  const again = await openShortcuts({ kv: { [WEB_KEY]: String(saved) } });
  expect(showsKeys(again.app, "chat-newTopic", "Ctrl+Shift+Y")).toBe(true);
  const desktop = await openShortcuts({ runtime: "desktop", kv: { [WEB_KEY]: String(saved) } });
  expect(showsKeys(desktop.app, "chat-newTopic", "Ctrl+N")).toBe(true);
});

test("Escape and Cancel stop recording and keep the keys; refused keys say why and keep recording", async () => {
  const { app } = await openShortcuts();
  await app.press("id:shortcut-change-chat-newTopic");
  await app.waitFor("id:shortcut-recording-chat-newTopic");
  await app.keyboard.press("escape");
  await app.waitFor("id:shortcut-recording-chat-newTopic", { state: "gone" });
  expect(showsKeys(app, "chat-newTopic", "Ctrl+Shift+O")).toBe(true);

  await app.press("id:shortcut-change-chat-newTopic");
  await app.waitFor("id:shortcut-cancel-chat-newTopic");
  await app.press("id:shortcut-cancel-chat-newTopic");
  await app.waitFor("id:shortcut-recording-chat-newTopic", { state: "gone" });
  expect(app.shows("id:shortcut-change-chat-newTopic")).toBe(true);

  // Ctrl+C copies, Ctrl+T is the browser's: both refused with the reason, still recording.
  await app.press("id:shortcut-change-chat-newTopic");
  await app.keyboard.press("ctrl+c");
  await app.waitFor("id:shortcut-error-chat-newTopic");
  expect(app.shows("id:shortcut-row-chat-newTopic >> text:/it edits text/")).toBe(true);
  await app.keyboard.press("ctrl+t");
  await app.waitFor("id:shortcut-row-chat-newTopic >> text:/the browser keeps it/");
  expect(app.shows("id:shortcut-recording-chat-newTopic")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:shortcut-recording-chat-newTopic", { state: "gone" });
  expect(showsKeys(app, "chat-newTopic", "Ctrl+Shift+O")).toBe(true);
  expect(savedValue(app, WEB_KEY)).toBe(undefined);
});

test("keys another action has are not taken until Reassign says so", async () => {
  const { app } = await openShortcuts();
  await app.press("id:shortcut-change-chat-newTopic");
  await app.keyboard.press("ctrl+k");
  await app.waitFor("id:shortcut-conflict-chat-newTopic");
  expect(app.shows("id:shortcut-conflict-chat-newTopic >> text:/Ctrl\\+K is already the shortcut for Search topics/")).toBe(true);
  expect(showsKeys(app, "chat-newTopic", "Ctrl+Shift+O")).toBe(true);
  expect(savedValue(app, WEB_KEY)).toBe(undefined);
  // Cancel keeps both as they were.
  await app.press("id:shortcut-dismiss-chat-newTopic");
  await app.waitFor("id:shortcut-conflict-chat-newTopic", { state: "gone" });
  expect(showsKeys(app, "chat-searchTopics", "Ctrl+K")).toBe(true);

  await app.press("id:shortcut-change-chat-newTopic");
  await app.keyboard.press("ctrl+k");
  await app.waitFor("id:shortcut-reassign-chat-newTopic");
  await app.press("id:shortcut-reassign-chat-newTopic");
  await app.waitUntil(() => showsKeys(app, "chat-newTopic", "Ctrl+K"));
  expect(showsKeys(app, "chat-searchTopics", "None")).toBe(true);
  expect(JSON.parse(String(savedValue(app, WEB_KEY))).bindings).toEqual({ "chat.searchTopics": "", "chat.newTopic": "ctrl+k" });
  // Search's default is New topic's now: restoring it is refused with what to do.
  await app.press("id:shortcut-reset-chat-searchTopics");
  await app.waitFor("id:shortcut-error-chat-searchTopics");
  expect(app.shows("id:shortcut-row-chat-searchTopics >> text:/Change or remove that one first/")).toBe(true);
});

test("Remove, Reset and Restore all defaults", async () => {
  const { app } = await openShortcuts();
  await app.press("id:shortcut-clear-nav-todo");
  await app.waitUntil(() => showsKeys(app, "nav-todo", "None"));
  expect(app.shows("id:shortcut-row-nav-todo >> text:No shortcut")).toBe(true);
  expect(JSON.parse(String(savedValue(app, WEB_KEY))).bindings).toEqual({ "nav.todo": "" });
  await app.press("id:shortcut-reset-nav-todo");
  await app.waitUntil(() => showsKeys(app, "nav-todo", "Alt+Shift+3"));
  expect(savedValue(app, WEB_KEY)).toBe(null);

  await app.press("id:shortcut-clear-nav-todo");
  await app.press("id:shortcut-change-nav-chat");
  await app.keyboard.press("ctrl+shift+u");
  await app.waitUntil(() => showsKeys(app, "nav-chat", "Ctrl+Shift+U"));
  expect(app.enabled("id:shortcuts-reset-all")).toBe(true);
  await app.press("id:shortcuts-reset-all");
  await app.waitFor("text:Restore every default shortcut?");
  await app.press("text:Restore defaults");
  await app.waitUntil(() => showsKeys(app, "nav-chat", "Alt+Shift+1"));
  expect(showsKeys(app, "nav-todo", "Alt+Shift+3")).toBe(true);
  expect(savedValue(app, WEB_KEY)).toBe(null);
});

test("damaged saved shortcuts fall back to the defaults, and still save", async () => {
  const { app } = await openShortcuts({ kv: { [WEB_KEY]: "{oops" } });
  expect(showsKeys(app, "chat-newTopic", "Ctrl+Shift+O")).toBe(true);
  await app.press("id:shortcut-clear-chat-newTopic");
  await app.waitUntil(() => showsKeys(app, "chat-newTopic", "None"));
  expect(JSON.parse(String(savedValue(app, WEB_KEY))).bindings).toEqual({ "chat.newTopic": "" });
  // Two actions saved with the same keys elsewhere: only the first acts, the other says so.
  const clash = JSON.stringify({ version: 1, bindings: { "nav.chat": "ctrl+shift+j", "nav.todo": "ctrl+shift+j" } });
  const second = await openShortcuts({ kv: { [WEB_KEY]: clash } });
  expect(second.app.shows("id:shortcut-row-nav-todo >> text:/Go to Topics has the same keys/")).toBe(true);
});

test("a shortcut acts once per press, in text fields too unless its keys type there", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", api: CHAT_API });
  await app.waitFor("id:chat-topic-new");
  await app.type("id:chat-composer-input", "Why");
  // Ctrl+\\ folds the sidebar, from the message field too: once per press (a second run in the
  // same press would unfold it again).
  await app.keyboard.press("ctrl+\\");
  await app.waitUntil(() => savedValue(app, "mistermorph.sidebarCollapsed") === "1");
  await app.keyboard.press("ctrl+\\");
  await app.waitUntil(() => savedValue(app, "mistermorph.sidebarCollapsed") === "0");
  const folds = app.host.calls().filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === "mistermorph.sidebarCollapsed");
  expect(folds.map((call) => (call.data as any).value)).toEqual(["1", "0"]);

  // Shift+/ types a "?" and Alt+Shift+2 goes nowhere while the field has the focus.
  await app.keyboard.press("shift+/");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Why?");
  await app.keyboard.press("alt+shift+2");
  expect(app.shows("id:contacts-page")).toBe(false);
  expect(app.shows("id:settings-shortcuts")).toBe(false);
  // Ctrl+Shift+O starts a new topic from it.
  await app.keyboard.press("ctrl+shift+o");
  await app.waitFor("id:chat-placeholder");
});

test("outside text fields the typing keys act: the pages, then the shortcut list", async () => {
  const { app } = await openConsole({ location: "/e/default/contacts", api: CHAT_API });
  await app.waitFor("id:contacts-page");
  await app.keyboard.press("alt+shift+3");
  await app.waitFor("id:todo-page");
  expect(lastLocation(app)).toContain("/todo");
  await app.keyboard.press("shift+/");
  await app.waitFor("id:settings-shortcuts");
  expect(lastLocation(app)).toContain("/settings/shortcuts");
});

test("chat's shortcuts act only on the chat page, and focus what they name", async () => {
  const { app } = await openConsole({ location: "/e/default/contacts", runtime: "desktop", api: CHAT_API });
  await app.waitFor("id:contacts-page");
  // Ctrl+N (new topic) has nothing to do here: nothing happens.
  await app.keyboard.press("ctrl+n");
  expect(app.shows("id:chat-page")).toBe(false);
  await app.keyboard.press("ctrl+1");
  await app.waitFor("id:chat-composer-input");
  await app.waitFor("id:chat-topics-search");
  await app.keyboard.press("ctrl+k");
  await app.wait(50);
  expect(await focusedInput(app, "id:chat-topics-search")).toBe(true);
  await app.keyboard.press("ctrl+i");
  expect(await focusedInput(app, "id:chat-composer-input")).toBe(true);
  expect(app.value("id:chat-topics-search")).toBe("`");
});

test("no shortcut acts under a dialog or while Settings records one", async () => {
  const saved = JSON.stringify({ version: 1, bindings: { "nav.todo": "" } });
  const { app } = await openShortcuts({ kv: { [WEB_KEY]: saved } });
  await app.press("id:shortcuts-reset-all");
  await app.waitFor("text:Restore every default shortcut?");
  await app.keyboard.press("alt+shift+2");
  expect(app.shows("id:contacts-page")).toBe(false);
  expect(app.shows("text:Restore every default shortcut?")).toBe(true);
  await app.press("text:Cancel");
  await app.waitFor("text:Restore every default shortcut?", { state: "gone" });

  // Recording: the keys of another shortcut are recorded (here: a conflict), not run.
  await app.press("id:shortcut-change-chat-newTopic");
  await app.keyboard.press("alt+shift+2");
  await app.waitFor("id:shortcut-conflict-chat-newTopic");
  expect(app.shows("id:contacts-page")).toBe(false);
  await app.press("id:shortcut-dismiss-chat-newTopic");
  // Done recording, the shortcuts are back.
  await app.keyboard.press("alt+shift+2");
  await app.waitFor("id:contacts-page");
});

test("tooltips show the keys in effect", async () => {
  const saved = JSON.stringify({ version: 1, bindings: { "chat.newTopic": "ctrl+shift+y" } });
  const { app } = await openConsole({ location: "/e/default/chat", api: CHAT_API, kv: { [WEB_KEY]: saved } });
  await app.waitFor("id:chat-topic-new");
  await app.hover("id:chat-topic-new");
  await app.waitFor("text:Ctrl+Shift+Y");
  await app.hover("id:nav-contacts");
  await app.waitFor("text:Alt+Shift+2");
});

test("a text editor keeps its own keys while it has the focus; other shortcuts still act", async () => {
  // Ctrl+L selects a line in the editor; bound here to folding the sidebar (Settings notes the clash).
  const saved = JSON.stringify({ version: 1, bindings: { "frame.toggleSidebar": "ctrl+l", "nav.chat": "ctrl+shift+1" } });
  const tasks = { tasks: [], system_tasks: [], chat_options: [], llm_profiles: [], heartbeat_enabled: false, runs: [] };
  const { app } = await openConsole({
    location: "/e/default/todo",
    runtime: "desktop",
    kv: { [DESKTOP_KEY]: saved },
    api: {
      "GET /proxy:/todo/tasks": { body: tasks },
      "GET /proxy:/todo/runs": { body: { runs: [] } },
      "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
    },
  });
  await app.waitFor("id:todo-empty-add");
  await app.press("id:todo-empty-add");
  await app.waitFor("id:todo-content-source");
  await app.type("id:todo-content-source", "Water the plants");
  // nsh puts the editor's own bindings after the app's, so it keeps its keys even when the
  // shortcuts are bound again meanwhile (another window saved them).
  const changed = JSON.stringify({ version: 1, bindings: { "frame.toggleSidebar": "ctrl+l", "nav.chat": "ctrl+shift+1", "nav.audit": "" } });
  await app.host.send("morph.kv", { key: DESKTOP_KEY, value: changed });
  await app.keyboard.press("ctrl+l");
  await app.wait(50);
  expect(savedValue(app, "mistermorph.sidebarCollapsed")).toBe(undefined);
  // Ctrl+Shift+1 is no editor key: it still acts.
  await app.keyboard.press("ctrl+shift+1");
  await app.waitFor("id:chat-page");
});

test("the editor's keys act as shortcuts outside the editor", async () => {
  const saved = JSON.stringify({ version: 1, bindings: { "frame.toggleSidebar": "ctrl+l" } });
  const { app } = await openConsole({ location: "/e/default/todo", runtime: "desktop", kv: { [DESKTOP_KEY]: saved } });
  await app.waitFor("id:todo-page");
  await app.keyboard.press("ctrl+l");
  await app.waitUntil(() => savedValue(app, "mistermorph.sidebarCollapsed") === "1");
});
