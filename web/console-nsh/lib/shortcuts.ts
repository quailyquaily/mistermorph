// The Console's keyboard shortcuts: the actions that have one, their default keys in a browser and
// in the apps, the user's changes (saved per environment), and the checks a new key passes before
// it is saved. The keys themselves are bound in one place, components/frame/shortcutDispatch.ts,
// through nsh's `keymap` (which already leaves text fields their typing and editing keys, ignores
// keys an input method is composing, and fires once per press of a held key); pages say what an
// action does with `provideShortcut`. docs/console/keyboard-shortcuts.md lists the defaults.
//
// A keystroke is nsh's text (`"mod+shift+o"`, `"alt+shift+1"`): `mod` is Command on Apple
// keyboards and Control elsewhere. Saved keystrokes are canonical (`"ctrl+shift+o"`), so a saved
// key means the same keys wherever it is read.
import { batch, cleanup, computed, keymap, platform, signal, untracked } from "nsh";
import { localStore, onKvChange, runtime } from "./platform";

/** Where the Console runs: in a browser, or in an app (the desktop app; the phone app too). */
export type ShortcutEnv = "web" | "desktop";

export type ShortcutGroup = "chat" | "navigation" | "help";

export interface ShortcutAction {
  id: string;
  group: ShortcutGroup;
  /** The i18n key of its name (with `page` for the navigation ones). */
  titleKey: string;
  /** The navigation's page (`/chat`): its nav item's title names the action. */
  page?: string;
  /** Its keys when nothing was changed, per environment ("" for none). */
  defaults: Record<ShortcutEnv, string>;
}

// Browsers never pass Control/Command with N, T, W or a digit to the page (new window, tabs), so
// the browser's defaults use Control/Command+Shift+O for a new topic and Alt+Shift with a digit for
// the pages. Every default stays clear of the text editor's own keys (`editorKeys`) and of the
// browser's well-known ones (BROWSER_WARNINGS).
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "chat.newTopic", group: "chat", titleKey: "shortcuts_action_new_topic", defaults: { desktop: "mod+n", web: "mod+shift+o" } },
  { id: "chat.searchTopics", group: "chat", titleKey: "shortcuts_action_search_topics", defaults: { desktop: "mod+k", web: "mod+k" } },
  { id: "chat.focusComposer", group: "chat", titleKey: "shortcuts_action_focus_composer", defaults: { desktop: "mod+i", web: "mod+i" } },
  { id: "nav.chat", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/chat", defaults: { desktop: "mod+1", web: "alt+shift+1" } },
  { id: "nav.contacts", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/contacts", defaults: { desktop: "mod+2", web: "alt+shift+2" } },
  { id: "nav.todo", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/todo", defaults: { desktop: "mod+3", web: "alt+shift+3" } },
  { id: "nav.memories", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/memories", defaults: { desktop: "mod+4", web: "alt+shift+4" } },
  { id: "nav.skills", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/skills", defaults: { desktop: "mod+5", web: "alt+shift+5" } },
  { id: "nav.stats", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/stats", defaults: { desktop: "mod+6", web: "alt+shift+6" } },
  { id: "nav.audit", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/audit", defaults: { desktop: "mod+7", web: "alt+shift+7" } },
  { id: "nav.settings", group: "navigation", titleKey: "shortcuts_action_go_to", page: "/settings", defaults: { desktop: "mod+,", web: "alt+shift+," } },
  { id: "frame.toggleSidebar", group: "navigation", titleKey: "shortcuts_action_toggle_sidebar", defaults: { desktop: "mod+\\", web: "mod+\\" } },
  { id: "help.shortcuts", group: "help", titleKey: "shortcuts_action_show_shortcuts", defaults: { desktop: "shift+/", web: "shift+/" } },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ["chat", "navigation", "help"];

export const shortcutAction = (id: string) => SHORTCUT_ACTIONS.find((action) => action.id === id);

/** The environment the Console runs in now. */
export const currentShortcutEnv = (): ShortcutEnv => (runtime() === "web" ? "web" : "desktop");

/* ---------- keystrokes ---------- */

export interface Stroke {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Command on Apple keyboards; the Windows / Super / Meta key elsewhere. */
  cmd: boolean;
  /** `a`-`z`, `0`-`9`, US punctuation, `f1`-`f24`, or a named key (`enter`, `space`, `up`). */
  key: string;
}

const NAMED: Record<string, string> = {
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  plus: "=",
  minus: "-",
};
const NAMED_KEYS = new Set(Object.values(NAMED).filter((key) => key.length > 1));
const CHAR_KEYS = "abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./";

/** Parses nsh's keystroke text; `apple`: `mod` is Command. Null when it is no keystroke. */
export function parseStroke(text: string, apple: boolean): Stroke | null {
  const lower = String(text ?? "").trim().toLowerCase();
  if (!lower || /\s/.test(lower) || lower.endsWith("++") || lower === "+") return null;
  const cut = lower.lastIndexOf("+", lower.length - 2);
  const mods = cut < 0 ? [] : lower.slice(0, cut).split("+");
  const name = cut < 0 ? lower : lower.slice(cut + 1);
  const stroke: Stroke = { ctrl: false, alt: false, shift: false, cmd: false, key: "" };
  for (const mod of mods) {
    let flag: "ctrl" | "alt" | "shift" | "cmd";
    if (mod === "ctrl" || mod === "control") flag = "ctrl";
    else if (mod === "alt" || mod === "option" || mod === "opt") flag = "alt";
    else if (mod === "shift") flag = "shift";
    else if (["cmd", "command", "meta", "super", "win"].includes(mod)) flag = "cmd";
    else if (["mod", "cmdorctrl", "commandorcontrol"].includes(mod)) flag = apple ? "cmd" : "ctrl";
    else return null;
    if (stroke[flag]) return null;
    stroke[flag] = true;
  }
  const key = NAMED[name] ?? name;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS.has(key) || (key.length === 1 && CHAR_KEYS.includes(key))) {
    stroke.key = key;
    return stroke;
  }
  return null;
}

/** The canonical text of a keystroke: `ctrl+alt+shift+cmd+<key>`, as nsh writes it. */
export function strokeText(stroke: Stroke): string {
  const mods = (["ctrl", "alt", "shift", "cmd"] as const).filter((flag) => stroke[flag]);
  return [...mods, stroke.key].join("+");
}

/** `text` in canonical form, or "" when it is no keystroke. */
export function canonicalKeys(text: string, apple: boolean): string {
  const stroke = parseStroke(text, apple);
  return stroke ? strokeText(stroke) : "";
}

let appleCache: boolean | null = null;
/** Whether shortcuts follow Apple's conventions here (`mod` is Command; ⌘ in labels). */
export function appleKeys(): boolean {
  if (appleCache === null) {
    try {
      appleCache = keymap.label("mod+a").includes("⌘");
    } catch {
      appleCache = platform.os === "macos" || platform.os === "ios";
    }
  }
  return appleCache;
}

/** Keys as hints show them here (`⇧⌘O`, `Ctrl+Shift+O`); "" for none. */
export function keysLabel(keys: string): string {
  if (!keys) return "";
  try {
    return keymap.label(keys);
  } catch {
    return keys;
  }
}

/* ---------- what a keystroke may be ---------- */

export type IssueLevel = "error" | "warning" | "note";
export interface ShortcutIssue {
  level: IssueLevel;
  /** The i18n key of the reason. */
  reason: string;
}

const MOVING_KEYS = new Set(["tab", "enter", "space", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete"]);
const EDITING_KEYS = new Set(["a", "c", "v", "x", "z", "y"]);

/** A list of keystrokes (nsh's text) in canonical form. */
function strokeSet(keys: string[], apple: boolean) {
  return new Set(keys.map((text) => canonicalKeys(text, apple)).filter(Boolean));
}

// nsh/base's code and Markdown editor (Memories, Skills, TODO, setup) binds these itself while it
// has the focus (nsh-base editor/keymap.rs). nsh puts the components' bindings after the app's, so
// there the editor keeps them; Settings says so for a shortcut on one of them.
const EDITOR_COMMON = [
  "mod+enter", "mod+shift+enter", "mod+]", "mod+[", "mod+z", "mod+shift+z", "mod+a", "mod+l", "mod+d", "mod+shift+l",
  "alt+up", "alt+down", "alt+shift+up", "alt+shift+down", "mod+shift+k", "mod+/", "mod+shift+\\", "ctrl+j",
  "shift+alt+a", "shift+alt+i", "f3", "shift+f3", "f12", "mod+.",
];
const EDITOR_APPLE = [
  "alt+left", "alt+shift+left", "alt+right", "alt+shift+right", "cmd+left", "cmd+shift+left", "cmd+right", "cmd+shift+right",
  "cmd+up", "cmd+shift+up", "cmd+down", "cmd+shift+down", "alt+backspace", "alt+delete", "cmd+backspace", "cmd+delete",
  "cmd+alt+up", "cmd+alt+down", "ctrl+a", "ctrl+shift+a", "ctrl+e", "ctrl+shift+e", "ctrl+b", "ctrl+f", "ctrl+p", "ctrl+n",
  "ctrl+h", "ctrl+d", "ctrl+k", "ctrl+t", "ctrl+alt+left", "ctrl+alt+shift+left", "ctrl+alt+right", "ctrl+alt+shift+right",
  "cmd+g", "cmd+shift+g", "cmd+e", "cmd+u", "cmd+alt+[", "cmd+alt+]", "ctrl+shift+cmd+right", "ctrl+shift+cmd+left",
];
const EDITOR_OTHERS = [
  "ctrl+left", "ctrl+shift+left", "ctrl+right", "ctrl+shift+right", "ctrl+home", "ctrl+shift+home", "ctrl+end", "ctrl+shift+end",
  "ctrl+backspace", "ctrl+delete", "ctrl+shift+backspace", "ctrl+shift+delete", "ctrl+alt+up", "ctrl+alt+down", "ctrl+y",
  "ctrl+u", "ctrl+shift+[", "ctrl+shift+]", "shift+alt+right", "shift+alt+left",
];
const editorKeySets = new Map<boolean, Set<string>>();
/** The text editor's own keystrokes (canonical) with Apple's conventions or not. */
export function editorKeys(apple: boolean): Set<string> {
  let set = editorKeySets.get(apple);
  if (!set) {
    set = strokeSet([...EDITOR_COMMON, ...(apple ? EDITOR_APPLE : EDITOR_OTHERS)], apple);
    editorKeySets.set(apple, set);
  }
  return set;
}

// What the system keeps for itself, whatever the app binds (nsh refuses the first ones too).
const SYSTEM_APPLE = ["cmd+q", "cmd+h", "cmd+alt+h", "cmd+m", "ctrl+cmd+f", "cmd+tab", "cmd+shift+tab", "cmd+space", "cmd+`"];
const SYSTEM_OTHERS = ["ctrl+q", "alt+f4", "f11", "alt+tab", "alt+shift+tab", "ctrl+alt+delete"];
// Keys browsers keep for their windows and tabs: the page never hears them.
const BROWSER_KEEPS = [
  "mod+n", "mod+shift+n", "mod+t", "mod+shift+t", "mod+w", "mod+shift+w", "ctrl+tab", "ctrl+shift+tab", "ctrl+pageup", "ctrl+pagedown",
  "mod+1", "mod+2", "mod+3", "mod+4", "mod+5", "mod+6", "mod+7", "mod+8", "mod+9",
];
const BROWSER_KEEPS_OTHERS = ["shift+escape", "ctrl+shift+q"];
const BROWSER_KEEPS_APPLE = ["cmd+shift+[", "cmd+shift+]", "cmd+alt+left", "cmd+alt+right"];
// Keys a page can take but browsers use for something people rely on: allowed, with a warning.
const BROWSER_WARNINGS: [string, string[], string[]][] = [
  // [reason, keys everywhere, keys on Apple keyboards (else elsewhere)]
  ["shortcuts_browser_address", ["mod+l", "f6"], []],
  ["shortcuts_browser_bookmark", ["mod+d", "mod+shift+d", "mod+shift+b"], []],
  ["shortcuts_browser_find", ["mod+f", "mod+g", "mod+shift+g", "f3"], []],
  ["shortcuts_browser_print", ["mod+p"], []],
  ["shortcuts_browser_save", ["mod+s"], []],
  ["shortcuts_browser_reload", ["mod+r", "mod+shift+r", "f5"], []],
  ["shortcuts_browser_history", ["mod+y"], []],
  ["shortcuts_browser_downloads", ["mod+j", "mod+shift+j"], []],
  ["shortcuts_browser_open", ["mod+o"], []],
  ["shortcuts_browser_source", ["mod+u", "mod+alt+u"], []],
  ["shortcuts_browser_zoom", ["mod+=", "mod+-", "mod+0", "mod+shift+="], []],
  ["shortcuts_browser_devtools", ["f12", "mod+shift+i", "mod+shift+c", "mod+alt+i", "mod+alt+j", "mod+alt+c"], []],
];
const BROWSER_WARNINGS_APPLE: [string, string[]][] = [
  ["shortcuts_browser_back", ["cmd+[", "cmd+]", "cmd+left", "cmd+right"]],
  ["shortcuts_browser_history", ["cmd+shift+h"]],
];
const BROWSER_WARNINGS_OTHERS: [string, string[]][] = [
  ["shortcuts_browser_back", ["alt+left", "alt+right", "alt+home"]],
  ["shortcuts_browser_address", ["alt+d"]],
  ["shortcuts_browser_history", ["ctrl+h"]],
];

/**
 * What stands in the way of `keys` as a shortcut in `env` (`apple`: Apple's conventions): an
 * error (it cannot be used: the system, the browser or the Console keeps it), a warning (it works,
 * but replaces a browser feature while the Console has the focus), a note (it works with limits),
 * or null.
 */
export function shortcutIssue(keys: string, env: ShortcutEnv, apple: boolean): ShortcutIssue | null {
  const stroke = parseStroke(keys, apple);
  if (!stroke) return { level: "error", reason: "shortcuts_reason_invalid" };
  const text = strokeText(stroke);
  const has = (list: string[]) => strokeSet(list, apple).has(text);
  const command = stroke.ctrl || stroke.cmd;
  // Alone or with Shift (selecting, Shift+Tab, a new line), save Shift+Escape.
  if (!stroke.ctrl && !stroke.alt && !stroke.cmd && MOVING_KEYS.has(stroke.key) && !(stroke.shift && stroke.key === "escape")) {
    return { level: "error", reason: "shortcuts_reason_moving" };
  }
  if (command && !stroke.alt && EDITING_KEYS.has(stroke.key) && (!stroke.shift || stroke.key === "z")) {
    return { level: "error", reason: "shortcuts_reason_editing" };
  }
  if (!apple && stroke.cmd) return { level: "error", reason: "shortcuts_reason_super" };
  if (has(apple ? SYSTEM_APPLE : SYSTEM_OTHERS)) return { level: "error", reason: "shortcuts_reason_system" };
  if (env === "web" && has([...BROWSER_KEEPS, ...(apple ? BROWSER_KEEPS_APPLE : BROWSER_KEEPS_OTHERS)])) {
    return { level: "error", reason: "shortcuts_reason_browser" };
  }
  if (env === "web") {
    for (const [reason, list] of BROWSER_WARNINGS) if (has(list)) return { level: "warning", reason };
    for (const [reason, list] of apple ? BROWSER_WARNINGS_APPLE : BROWSER_WARNINGS_OTHERS) if (has(list)) return { level: "warning", reason };
  }
  if (editorKeys(apple).has(text)) return { level: "note", reason: "shortcuts_note_editor" };
  // Without Control or Command a key types (Alt and Option type characters on many keyboards):
  // nsh leaves it to a focused text field.
  if (!command && stroke.key.length === 1) return { level: "note", reason: "shortcuts_note_typing" };
  return null;
}

/* ---------- the user's changes ---------- */

/** Where an environment's changes are saved (the host's saved values: `localStorage` on the web). */
export const shortcutStorageKey = (env: ShortcutEnv) => `mistermorph.shortcuts.${env}`;
const STORAGE_VERSION = 1;

/**
 * The changes saved as `raw`: action id → canonical keys, or "" for an action whose shortcut was
 * removed. Anything unreadable is dropped (that action keeps its default): a missing, damaged or
 * foreign value is no change at all.
 */
export function parseShortcutOverrides(raw: string | null, env: ShortcutEnv, apple: boolean): Record<string, string> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn("keyboard shortcuts: the saved shortcuts are not JSON; using the defaults");
    return {};
  }
  const bindings = (data as { bindings?: unknown })?.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    console.warn("keyboard shortcuts: the saved shortcuts have no bindings; using the defaults");
    return {};
  }
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(bindings as Record<string, unknown>)) {
    if (!shortcutAction(id) || typeof value !== "string") continue;
    if (value === "") {
      out[id] = "";
      continue;
    }
    const keys = canonicalKeys(value, apple);
    if (!keys || shortcutIssue(keys, env, apple)?.level === "error") {
      console.warn(`keyboard shortcuts: ignoring the saved ${JSON.stringify(value)} of ${id}`);
      continue;
    }
    out[id] = keys;
  }
  return out;
}

export function serializeShortcutOverrides(overrides: Record<string, string>) {
  return JSON.stringify({ version: STORAGE_VERSION, bindings: overrides });
}

export type BindingSource = "default" | "custom" | "none";
export interface EffectiveBinding {
  id: string;
  /** Canonical keys, "" for none. */
  keys: string;
  source: BindingSource;
  /** Another action took the same keys first: this one does not fire (shown in Settings). */
  shadowedBy?: string;
}

/**
 * Every action's keys in `env` with `overrides`: a change wins over a default; where two still
 * share keys (saved data from elsewhere, or a later version's new default), the first in the list
 * keeps them and the other is shown as blocked: one key never fires two actions.
 */
export function resolveShortcuts(env: ShortcutEnv, overrides: Record<string, string>, apple: boolean): EffectiveBinding[] {
  const list: EffectiveBinding[] = SHORTCUT_ACTIONS.map((action) => {
    if (Object.prototype.hasOwnProperty.call(overrides, action.id)) {
      const keys = overrides[action.id];
      return { id: action.id, keys, source: keys ? "custom" : "none" };
    }
    const keys = canonicalKeys(action.defaults[env], apple);
    return { id: action.id, keys, source: keys ? "default" : "none" };
  });
  const owner = new Map<string, string>();
  for (const pass of ["custom", "default"] as BindingSource[]) {
    for (const binding of list) {
      if (binding.source !== pass || !binding.keys) continue;
      const taken = owner.get(binding.keys);
      if (taken) binding.shadowedBy = taken;
      else owner.set(binding.keys, binding.id);
    }
  }
  return list;
}

/* ---------- state ---------- */

const overrides = signal<Record<string, string>>({});
let loadedEnv: ShortcutEnv | null = null;
let stopKvListener: (() => void) | null = null;

function read(env: ShortcutEnv) {
  return parseShortcutOverrides(localStore.getItem(shortcutStorageKey(env)), env, appleKeys());
}

/** Reads the saved changes of this environment (once; again when another window saves them). */
export function loadShortcuts() {
  const env = currentShortcutEnv();
  if (loadedEnv === env) return;
  loadedEnv = env;
  overrides.set(read(env));
  stopKvListener?.();
  stopKvListener = onKvChange((key) => {
    if (loadedEnv && key === shortcutStorageKey(loadedEnv)) overrides.set(read(loadedEnv));
  });
}

export const shortcutOverrides = () => overrides();

/** Every action's keys here and now. */
export const effectiveShortcuts = computed(() => resolveShortcuts(currentShortcutEnv(), overrides(), appleKeys()));

/** An action's keys here ("" for none, or when another action holds them). */
export function shortcutKeys(id: string): string {
  const binding = effectiveShortcuts().find((item) => item.id === id);
  return binding && !binding.shadowedBy ? binding.keys : "";
}

/** An action's keys as hints show them ("" for none). */
export const shortcutLabel = (id: string) => keysLabel(shortcutKeys(id));

/** An action's default keys here (canonical, "" for none). */
export const defaultShortcutKeys = (id: string) => canonicalKeys(shortcutAction(id)?.defaults[currentShortcutEnv()] ?? "", appleKeys());

function save(next: Record<string, string>) {
  const env = loadedEnv ?? currentShortcutEnv();
  overrides.set(next);
  if (Object.keys(next).length === 0) localStore.removeItem(shortcutStorageKey(env));
  else localStore.setItem(shortcutStorageKey(env), serializeShortcutOverrides(next));
}

export interface ShortcutCheck {
  /** Canonical keys. */
  keys: string;
  /** Why they cannot be used, or what to know about them. */
  issue: ShortcutIssue | null;
  /** The action that has these keys now. */
  conflict?: string;
}

/** What saving `keys` for action `id` would meet. */
export function checkShortcut(id: string, keys: string): ShortcutCheck {
  const apple = appleKeys();
  const canonical = canonicalKeys(keys, apple);
  const issue = shortcutIssue(keys, currentShortcutEnv(), apple);
  const conflict = canonical
    ? untracked(effectiveShortcuts).find((binding) => binding.id !== id && binding.keys === canonical)?.id
    : undefined;
  return { keys: canonical, issue, conflict };
}

/**
 * Gives action `id` the keys `keys` ("" removes its shortcut). Refuses keys that cannot be used
 * or that another action has (`reassignFrom` names that action to take them from it, which then
 * has none). Returns whether it saved.
 */
export function setShortcut(id: string, keys: string, reassignFrom?: string): boolean {
  if (!shortcutAction(id)) return false;
  const current = { ...untracked(overrides) };
  if (keys === "") {
    current[id] = "";
    save(current);
    return true;
  }
  const check = checkShortcut(id, keys);
  if (!check.keys || check.issue?.level === "error") return false;
  if (check.conflict && check.conflict !== reassignFrom) return false;
  batch(() => {
    if (check.conflict) current[check.conflict] = "";
    if (check.keys === defaultShortcutKeys(id)) delete current[id];
    else current[id] = check.keys;
    save(current);
  });
  return true;
}

/** Back to action `id`'s default keys. Refused (false) while another action has them. */
export function resetShortcut(id: string): boolean {
  const current = { ...untracked(overrides) };
  if (!Object.prototype.hasOwnProperty.call(current, id)) return true;
  const keys = defaultShortcutKeys(id);
  if (keys && untracked(effectiveShortcuts).some((binding) => binding.id !== id && binding.keys === keys && !binding.shadowedBy)) return false;
  delete current[id];
  save(current);
  return true;
}

/** Every action back to its default keys. */
export function resetAllShortcuts() {
  save({});
}

/* ---------- who acts ---------- */

interface Provider {
  id: string;
  run: () => void;
  available: () => boolean;
}
const providers = signal<Provider[]>([]);

/**
 * Says what action `id` does while the calling component is mounted, and when it can
 * (`available`, read reactively). The newest provider of an action is the one used.
 */
export function provideShortcut(id: string, run: () => void, available: () => boolean = () => true) {
  const provider: Provider = { id, run, available };
  untracked(() => providers.set([...providers(), provider]));
  cleanup(() => untracked(() => providers.set(providers().filter((item) => item !== provider))));
}

/** The provider that acts for `id` now, or null. */
export function shortcutProvider(id: string): Provider | null {
  const list = providers();
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].id === id) return list[i];
  return null;
}

/* ---------- when shortcuts hold back ---------- */

const recording = signal(false);
/** A shortcut is being recorded in Settings: every key goes to the recorder. */
export const shortcutRecording = () => recording();
export const setShortcutRecording = (on: boolean) => recording.set(Boolean(on));

/* ---------- recording ---------- */

const RECORD_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\;',./",
  "space", "enter", "tab", "backspace", "delete", "insert", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];
// What nsh refuses to bind on the apps (nsh-core keymap.rs `Keystroke::reserved`): the recorder
// leaves them alone, as the system does what they say anyway.
const NSH_RESERVED_APPLE = ["cmd+q", "cmd+h", "cmd+alt+h", "cmd+m", "ctrl+cmd+f"];
const NSH_RESERVED_OTHERS = ["ctrl+q", "alt+f4", "f11"];
const recorderCache = new Map<string, string[]>();

/**
 * Every keystroke the recorder listens to (canonical), Escape aside (it cancels): each key with
 * every set of modifiers (Command only on Apple keyboards: elsewhere the Windows / Super key is the
 * system's). Tab and Shift+Tab are left to move the focus. `os` is nsh's `platform.os`.
 */
export function recorderKeystrokes(apple: boolean, os: string): string[] {
  const cacheKey = `${apple}:${os}`;
  const cached = recorderCache.get(cacheKey);
  if (cached) return cached;
  const reserved = os === "web" ? new Set<string>() : strokeSet(apple ? NSH_RESERVED_APPLE : NSH_RESERVED_OTHERS, apple);
  const flags = apple ? (["ctrl", "alt", "shift", "cmd"] as const) : (["ctrl", "alt", "shift"] as const);
  const list: string[] = [];
  for (let mask = 0; mask < 1 << flags.length; mask += 1) {
    const stroke: Stroke = { ctrl: false, alt: false, shift: false, cmd: false, key: "" };
    flags.forEach((flag, bit) => {
      if (mask & (1 << bit)) stroke[flag] = true;
    });
    const plain = !stroke.ctrl && !stroke.alt && !stroke.cmd;
    for (const key of RECORD_KEYS) {
      if (key === "tab" && plain) continue;
      const text = strokeText({ ...stroke, key });
      if (!reserved.has(text)) list.push(text);
    }
  }
  recorderCache.set(cacheKey, list);
  return list;
}
