// The keyboard shortcuts' model (lib/shortcuts.ts) on its own: the defaults per environment and
// keyboard, what a keystroke may be, reading damaged saved data, and one key never firing two
// actions. The Console's own use of it is in keyboard-shortcuts.test.tsx.
import { expect, test } from "nsh/test";
import {
  canonicalKeys,
  editorKeys,
  parseShortcutOverrides,
  parseStroke,
  recorderKeystrokes,
  resolveShortcuts,
  serializeShortcutOverrides,
  SHORTCUT_ACTIONS,
  shortcutIssue,
  type ShortcutEnv,
} from "../lib/shortcuts";

const ENVS: ShortcutEnv[] = ["web", "desktop"];
const keysOf = (env: ShortcutEnv, apple: boolean, overrides: Record<string, string> = {}) =>
  Object.fromEntries(resolveShortcuts(env, overrides, apple).map((binding) => [binding.id, binding.keys]));

test("keystrokes parse to one canonical text, with mod as Command on Apple keyboards only", () => {
  expect(canonicalKeys("mod+shift+o", false)).toBe("ctrl+shift+o");
  expect(canonicalKeys("Mod+Shift+O", true)).toBe("shift+cmd+o");
  expect(canonicalKeys("shift+alt+ctrl+k", false)).toBe("ctrl+alt+shift+k");
  expect(canonicalKeys("mod+plus", false)).toBe("ctrl+=");
  expect(canonicalKeys("mod+-", false)).toBe("ctrl+-");
  expect(canonicalKeys("mod+\\", false)).toBe("ctrl+\\");
  expect(canonicalKeys("F5", false)).toBe("f5");
  for (const bad of ["", "mod+", "mod++", "ctrl+ctrl+k", "hyper+k", "mod+k mod+s", "f25", "?"]) {
    expect(parseStroke(bad, false)).toBe(null);
  }
});

test("the browser and the apps have their own defaults, with Command on Apple keyboards", () => {
  const web = keysOf("web", false);
  const desktop = keysOf("desktop", false);
  expect(web["chat.newTopic"]).toBe("ctrl+shift+o");
  expect(desktop["chat.newTopic"]).toBe("ctrl+n");
  expect(web["nav.contacts"]).toBe("alt+shift+2");
  expect(desktop["nav.contacts"]).toBe("ctrl+2");
  expect(desktop["nav.settings"]).toBe("ctrl+,");
  expect(web["chat.searchTopics"]).toBe("ctrl+k");
  expect(keysOf("desktop", true)["chat.newTopic"]).toBe("cmd+n");
  expect(keysOf("web", true)["chat.newTopic"]).toBe("shift+cmd+o");
  expect(keysOf("desktop", true)["help.shortcuts"]).toBe("shift+/");
});

test("every default can be used where it is the default: no clash, no browser key, no editor key", () => {
  for (const env of ENVS) {
    for (const apple of [false, true]) {
      const seen = new Set<string>();
      for (const binding of resolveShortcuts(env, {}, apple)) {
        expect(binding.keys).not.toBe("");
        expect(seen.has(binding.keys)).toBe(false);
        seen.add(binding.keys);
        expect(binding.shadowedBy).toBe(undefined);
        const issue = shortcutIssue(binding.keys, env, apple);
        // Only notes (Alt+Shift and Shift+/ type in a text field, so they act outside one).
        expect(issue === null || issue.level === "note").toBe(true);
        expect(issue?.reason === "shortcuts_note_editor").toBe(false);
        expect(editorKeys(apple).has(binding.keys)).toBe(false);
      }
    }
  }
  expect(SHORTCUT_ACTIONS.length).toBe(13);
});

test("keys the system, the browser or the Console keep are refused, with the reason", () => {
  const reason = (keys: string, env: ShortcutEnv, apple = false) => shortcutIssue(keys, env, apple);
  expect(reason("tab", "desktop")).toEqual({ level: "error", reason: "shortcuts_reason_moving" });
  expect(reason("shift+tab", "web")?.reason).toBe("shortcuts_reason_moving");
  expect(reason("enter", "web")?.reason).toBe("shortcuts_reason_moving");
  expect(reason("escape", "desktop")?.reason).toBe("shortcuts_reason_moving");
  expect(reason("mod+c", "desktop")?.reason).toBe("shortcuts_reason_editing");
  expect(reason("mod+shift+z", "web", true)?.reason).toBe("shortcuts_reason_editing");
  expect(reason("cmd+q", "desktop", true)?.reason).toBe("shortcuts_reason_system");
  expect(reason("ctrl+q", "desktop")?.reason).toBe("shortcuts_reason_system");
  expect(reason("alt+f4", "web")?.reason).toBe("shortcuts_reason_system");
  expect(reason("super+k", "desktop")?.reason).toBe("shortcuts_reason_super");
  // The browser keeps new windows and tabs to itself; the desktop app does not have them.
  expect(reason("mod+t", "web")?.reason).toBe("shortcuts_reason_browser");
  expect(reason("mod+n", "web", true)?.reason).toBe("shortcuts_reason_browser");
  expect(reason("mod+1", "web")?.reason).toBe("shortcuts_reason_browser");
  expect(reason("shift+escape", "web")?.reason).toBe("shortcuts_reason_browser");
  expect(reason("mod+t", "desktop")).toBe(null);
  expect(reason("mod+1", "desktop")).toBe(null);
  // Allowed with a warning: a browser feature they replace while the Console has the focus.
  expect(reason("mod+p", "web")).toEqual({ level: "warning", reason: "shortcuts_browser_print" });
  expect(reason("alt+left", "web")?.reason).toBe("shortcuts_browser_back");
  expect(reason("mod+[", "web", true)?.reason).toBe("shortcuts_browser_back");
  expect(reason("mod+p", "desktop")).toBe(null);
  // Allowed with a note.
  expect(reason("mod+l", "desktop")).toEqual({ level: "note", reason: "shortcuts_note_editor" });
  expect(reason("g", "desktop")).toEqual({ level: "note", reason: "shortcuts_note_typing" });
  expect(reason("alt+shift+9", "web")?.reason).toBe("shortcuts_note_typing");
  expect(reason("mod+shift+y", "web")).toBe(null);
});

test("saved changes: a removed shortcut stays removed, anything unreadable falls back to the default", () => {
  const saved = serializeShortcutOverrides({ "chat.newTopic": "ctrl+shift+y", "nav.chat": "" });
  expect(parseShortcutOverrides(saved, "web", false)).toEqual({ "chat.newTopic": "ctrl+shift+y", "nav.chat": "" });
  expect(parseShortcutOverrides(null, "web", false)).toEqual({});
  expect(parseShortcutOverrides("{not json", "web", false)).toEqual({});
  expect(parseShortcutOverrides("[1,2]", "web", false)).toEqual({});
  expect(parseShortcutOverrides(JSON.stringify({ bindings: [] }), "web", false)).toEqual({});
  const mixed = JSON.stringify({
    version: 1,
    bindings: {
      "chat.newTopic": "Mod+Shift+Y",
      "chat.searchTopics": 42,
      "no.such.action": "ctrl+j",
      "nav.chat": "ctrl+t",
      "nav.todo": "hyper+q",
      "nav.audit": "",
    },
  });
  // Ctrl+T is the browser's (dropped in the browser), fine in the desktop app.
  expect(parseShortcutOverrides(mixed, "web", false)).toEqual({ "chat.newTopic": "ctrl+shift+y", "nav.audit": "" });
  expect(parseShortcutOverrides(mixed, "desktop", false)).toEqual({ "chat.newTopic": "ctrl+shift+y", "nav.chat": "ctrl+t", "nav.audit": "" });
  // A removed shortcut is no default.
  const resolved = resolveShortcuts("web", { "nav.audit": "" }, false).find((binding) => binding.id === "nav.audit");
  expect(resolved).toEqual({ id: "nav.audit", keys: "", source: "none" });
});

test("one key never fires two actions: a change wins over a default, the first change over a later one", () => {
  const list = resolveShortcuts("desktop", { "chat.focusComposer": "ctrl+n", "nav.chat": "ctrl+j", "nav.todo": "ctrl+j" }, false);
  const by = (id: string) => list.find((binding) => binding.id === id)!;
  expect(by("chat.focusComposer")).toEqual({ id: "chat.focusComposer", keys: "ctrl+n", source: "custom" });
  expect(by("chat.newTopic").shadowedBy).toBe("chat.focusComposer");
  expect(by("nav.chat").shadowedBy).toBe(undefined);
  expect(by("nav.todo").shadowedBy).toBe("nav.chat");
});

test("the recorder hears every combination but Tab, Escape and what the platform keeps", () => {
  const linux = recorderKeystrokes(false, "linux");
  expect(linux.includes("ctrl+shift+k")).toBe(true);
  expect(linux.includes("alt+shift+1")).toBe(true);
  expect(linux.includes("g")).toBe(true);
  expect(linux.includes("tab")).toBe(false);
  expect(linux.includes("shift+tab")).toBe(false);
  expect(linux.includes("ctrl+tab")).toBe(true);
  expect(linux.some((keys) => keys.includes("escape"))).toBe(false);
  expect(linux.includes("ctrl+q")).toBe(false);
  expect(linux.includes("f11")).toBe(false);
  expect(linux.some((keys) => keys.includes("cmd"))).toBe(false);
  const mac = recorderKeystrokes(true, "macos");
  expect(mac.includes("shift+cmd+o")).toBe(true);
  expect(mac.includes("cmd+q")).toBe(false);
  // nsh keeps nothing in a browser: the browser does.
  expect(recorderKeystrokes(false, "web").includes("ctrl+q")).toBe(true);
  expect(new Set(linux).size).toBe(linux.length);
});
