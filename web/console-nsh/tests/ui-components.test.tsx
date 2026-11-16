// The UI component gallery (/ui-components, pages/ui-components): a testing page with a route and
// no navigation entry, guarded as any page, showing every component of the console from synthetic
// data, in each language, without talking to the console or an agent.
import { expect, test } from "nsh/test";
import { LANGUAGES } from "../components/LanguageSelector";
import { NAV_ITEMS_META } from "../lib/navOrder";
import { DEMOS } from "../pages/ui-components/demos";
import { GALLERY_ENTRIES, GALLERY_GROUPS } from "../pages/ui-components/inventory.js";
import { openConsole } from "./harness";

const PATH = "/ui-components";

/** The last location the app wrote to the address bar. */
function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  /**
 * What was asked after the page loaded. The app's notification stream asks for a new ticket each
 * time it reconnects, on every page (the tests have no stream to connect to): that is the frame's,
 * not the gallery's.
 */
const afterLoad = (calls: { method: string; path: string; uri?: string }[], loaded: number) =>
  requests(calls.slice(loaded)).filter((request) => request !== "POST /stream/ticket");
const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}
const requests = (calls: { method: string; path: string; uri?: string }[]) => calls.map((call) => `${call.method} ${call.path}${call.uri ? `:${call.uri.split("?")[0]}` : ""}`);
/** What the route guard and the frame ask on any page: nothing else may be asked here. */
const BOOT = new Set([
  "GET /auth/config",
  "POST /auth/login",
  "GET /auth/me",
  "GET /setup/integrity",
  "GET /endpoints",
  "POST /stream/ticket",
  "GET /proxy:/state/files",
  "GET /proxy:/persona/identity",
  "GET /proxy/download:/persona/avatar",
  "GET /proxy:/contacts/list",
]);
/**
 * What was asked after the page loaded. The app's notification stream asks for a new ticket each
 * time it reconnects, on every page (the tests have no stream to connect to): that is the frame's,
 * not the gallery's.
 */
const afterLoad = (calls: { method: string; path: string; uri?: string }[], loaded: number) =>
  requests(calls.slice(loaded)).filter((request) => request !== "POST /stream/ticket");
const writes = (calls: { method: string; path: string }[]) => calls.filter((call) => call.method !== "GET" && !["/auth/login", "/stream/ticket"].includes(call.path));

test("the address opens the gallery directly, behind the session guard, with no frame around it", async () => {
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  expect(lastLocation(app)).toBe(PATH);
  expect(app.shows("text:UI components")).toBe(true);
  // A page of its own: no sidebar, no navigation.
  expect(app.shows("id:sidebar")).toBe(false);
  expect(app.shows("id:nav-chat")).toBe(false);
});

test("without a session the gallery asks for the password first, then opens", async () => {
  const { app } = await openConsole({ location: PATH, password: true });
  await app.waitFor("id:login-password");
  expect(app.shows("id:ui-components-page")).toBe(false);
  expect(lastLocation(app)).toBe(`/login?redirect=${encodeURIComponent(PATH)}`);
  await app.type("id:login-password", "secret");
  await app.press("role:button[Login]");
  await app.waitFor("id:ui-components-page");
  expect(lastLocation(app)).toBe(PATH);
});

test("an agent that is not set up yet gets its setup, not the gallery", async () => {
  const { app } = await openConsole({ location: PATH, api: { "GET /proxy:/state/files": { body: { items: [] } }, "GET /proxy:/persona/identity": { body: { exists: false } } } });
  await app.waitUntil(() => lastLocation(app).includes("/setup"));
  expect(app.shows("id:ui-components-page")).toBe(false);
});

test("the public preview stub is a different address and stays what it was", async () => {
  const { app } = await openConsole({ location: "/__components" });
  await app.waitFor("text:/__components");
  expect(app.shows("id:ui-components-page")).toBe(false);
});

test("no navigation leads to the gallery: not the sidebar, not the phone's bar or its More sheet", async () => {
  expect(NAV_ITEMS_META.some((item) => String(item.id).includes("ui-components"))).toBe(false);
  const desktop = await openConsole({ location: "/e/default/todo" });
  await desktop.app.waitFor("id:nav-todo");
  expect(desktop.app.texts().some((text) => /UI components/i.test(text))).toBe(false);
  const phone = await openConsole({ location: "/e/default/todo", platform: "android" });
  await phone.app.waitFor("id:mobile-bottom-nav");
  await phone.app.press("id:mobile-nav-more");
  await phone.app.waitFor("id:mobile-more-sheet");
  expect(phone.app.texts().some((text) => /UI components/i.test(text))).toBe(false);
});

test("every inventory entry is on the page: a demo for each component shown, a reason for each that is not", async () => {
  const demos = GALLERY_ENTRIES.filter((entry) => entry.mode === "demo");
  // The demos and the inventory name the same components.
  expect(demos.filter((entry) => !DEMOS[entry.id]).map((entry) => entry.id)).toEqual([]);
  expect(Object.keys(DEMOS).filter((id) => !demos.some((entry) => entry.id === id))).toEqual([]);
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  expect(app.shows(`text:${GALLERY_ENTRIES.length} components`)).toBe(true);
  for (const group of GALLERY_GROUPS) {
    expect(app.shows(`id:uig-group-${group.id}`)).toBe(true);
    expect(app.shows(`id:uig-index-${group.id}`)).toBe(true);
  }
  for (const entry of GALLERY_ENTRIES) {
    expect(app.shows(`id:${entry.mode === "demo" ? "uig-demo" : "uig-note"}-${entry.id}`)).toBe(true);
  }
  // A component that is not mounted says why, and one shown elsewhere says where.
  expect(app.shows("id:uig-note-Sidebar >> text:Not mounted: part of the app frame, bound to the router and the selected agent; pressing it would leave this page. The NavList demo shows its parts.")).toBe(true);
  expect(app.shows("id:uig-note-MenuIconTrigger >> text:Shown inside the DropdownMenu demo.")).toBe(true);
  expect(app.shows("id:uig-note-SidebarEdge >> text:Not mounted: a private part of Sidebar, which is not mounted on this page.")).toBe(true);
});

test("the index shows one section, the filter finds components by name or file, and an empty result says how to get back", async () => {
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  await app.press("id:uig-index-motion");
  await app.waitFor("id:uig-group-controls", { state: "gone" });
  expect(app.shows("id:uig-group-motion")).toBe(true);
  expect(app.shows("id:uig-demo-RunningMark")).toBe(true);
  expect(app.shows("id:uig-demo-Button")).toBe(false);
  // A name that is in another section: nothing here, and the way back.
  await app.type("id:uig-filter", "ChatComposer");
  await app.waitFor("id:uig-empty");
  expect(app.shows("id:uig-empty >> text:No component matches")).toBe(true);
  expect(app.texts().some((text) => text.includes("“ChatComposer”") && text.includes("Clear the filter"))).toBe(true);
  await app.press("id:uig-empty-reset");
  await app.waitFor("id:uig-group-controls");
  expect(app.shows("id:uig-empty")).toBe(false);
  expect(app.shows(`text:${GALLERY_ENTRIES.length} components`)).toBe(true);
  // By name across every section, then by file.
  await app.type("id:uig-filter", "composer");
  await app.waitFor("id:uig-demo-Button", { state: "gone" });
  expect(app.shows("id:uig-demo-ChatComposer")).toBe(true);
  expect(app.shows("id:uig-note-ComposerFieldSlot")).toBe(true);
  const named = GALLERY_ENTRIES.filter((entry) => [entry.name, entry.id, entry.file, entry.via ?? ""].some((text) => text.toLowerCase().includes("composer"))).length;
  expect(app.shows(`text:${named} of ${GALLERY_ENTRIES.length} components`)).toBe(true);
});

test("the address can name the section and the filter to start with", async () => {
  const { app } = await openConsole({ location: `${PATH}?group=overlays&q=modal` });
  await app.waitFor("id:uig-demo-Modal");
  expect(app.shows("id:uig-group-controls")).toBe(false);
  expect(app.shows("id:uig-demo-MessageDialog")).toBe(false);
});

test("the language control is the console's own: every language, the page and the examples change in place", async () => {
  expect(LANGUAGES.map((item) => item.value)).toEqual(["en", "zh", "ja"]);
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  for (const item of LANGUAGES) expect(app.shows(`id:uig-language >> text:${item.label}`)).toBe(true);
  const before = lastLocation(app);
  // English: the page's own strings, a fixture with a number in it, and a production component's string.
  expect(app.shows("id:uig-demo-Badge >> text:12 items")).toBe(true);
  expect(app.shows("id:uig-demo-Button >> text:Save")).toBe(true);
  await app.press("id:uig-language >> label:中文");
  await app.waitFor("text:UI 组件");
  expect(app.shows(`text:${GALLERY_ENTRIES.length} 个组件`)).toBe(true);
  expect(app.shows("id:uig-demo-Badge >> text:12 项")).toBe(true);
  expect(app.shows("id:uig-demo-Button >> text:保存")).toBe(true);
  expect(app.shows("id:uig-note-MenuIconTrigger >> text:在 DropdownMenu 的演示中展示。")).toBe(true);
  await app.press("id:uig-language >> label:日本語");
  await app.waitFor("text:UI コンポーネント");
  expect(app.shows("id:uig-demo-Badge >> text:12 件")).toBe(true);
  expect(app.shows("id:uig-demo-Button >> text:保存")).toBe(true);
  expect(app.shows("id:uig-note-MenuIconTrigger >> text:DropdownMenu のデモの中で表示されます。")).toBe(true);
  // The same page, still: no navigation, and the choice is the console's saved language.
  expect(lastLocation(app)).toBe(before);
  expect(app.host.calls().filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === "quail-language").map((call) => (call.data as any)?.value).at(-1)).toBe("ja");
  await app.press("id:uig-language >> label:English");
  await app.waitFor("text:UI components");
});

test("a saved language opens the gallery in it", async () => {
  const { app } = await openConsole({ location: PATH, kv: { "quail-language": "ja" } });
  await app.waitFor("text:UI コンポーネント");
});

test("the controls work on local state, the overlays open and close, and nothing is asked of the console", async () => {
  const { app, calls } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  await app.waitFor("id:uig-demo-ChatComposer");
  const loaded = calls.length;
  expect(requests(calls).filter((request) => !BOOT.has(request))).toEqual([]);
  expect(app.shows("text:No demo control pressed yet")).toBe(true);

  // A button, a switch, a field, a busy state and its reset.
  await app.press("id:uig-button-danger");
  await app.waitFor("text:Last local action: Button: danger (1 so far)");
  expect(app.shows("text:On")).toBe(true);
  await app.press("id:uig-toggle");
  await app.waitFor("text:Off");
  await app.type("id:uig-textfield-name", "Quill");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("Value: ") && text.includes("Quill")));
  await app.press("id:uig-progress-more");
  await app.waitFor("text:50% done");
  await app.press("id:uig-fold");
  await app.waitFor("id:uig-fold-body");

  // A dialog, a message, the confirm host and a notice: each opens and closes.
  await app.press("id:uig-modal-open-md");
  await app.waitFor("id:uig-modal");
  await app.press("id:uig-modal-cancel");
  await app.waitFor("id:uig-modal", { state: "gone" });
  await app.press("id:uig-message-open-danger");
  await app.waitFor("id:uig-message");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:uig-message", { state: "gone" });
  await app.press("id:uig-confirm-open");
  await app.waitFor("text:This dialog is part of the gallery. Its buttons only close it.");
  await app.press("id:dialog-action-confirm");
  await app.waitFor("text:Answer: confirmed");
  // The inline notice demos show the same sentence twice already; the notice stack adds one.
  const NOTICE = "A sample warning notice from the gallery.";
  const shownNotices = () => app.texts().filter((text) => text === NOTICE).length;
  const inline = shownNotices();
  await app.press("id:uig-notice-warning");
  await app.waitUntil(() => shownNotices() === inline + 1);
  await app.press("id:uig-notice-clear");
  await app.waitUntil(() => shownNotices() === inline);
  await app.press("id:uig-dialog-DialogShell");
  await app.waitFor("id:uig-dialogshell");
  await app.press("id:uig-dialogshell-done");
  await app.waitFor("id:uig-dialogshell", { state: "gone" });

  // What would send, save or approve in the console only notes the action here.
  await app.type("id:uig-composer-default >> id:chat-composer-input", "hello from the gallery");
  await app.press("id:uig-composer-default >> id:chat-composer-send");
  await app.waitUntil(() => app.texts().some((text) => text.includes("ChatComposer send: hello from the gallery")));
  await app.press("id:uig-savebar-toggle");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => app.texts().some((text) => text.includes("SettingsSaveBar: save")));

  expect(afterLoad(calls, loaded)).toEqual([]);
  expect(writes(calls)).toEqual([]);
  expect(lastLocation(app)).toBe(PATH);
});

test("on a phone the gallery is one column inside the window, and its popups are the phone's sheets", async () => {
  const { app, calls } = await openConsole({ location: PATH, platform: "android" });
  await app.waitFor("id:ui-components-page");
  await app.waitFor("id:uig-demo-Button");
  expect(app.shows("id:mobile-bottom-nav")).toBe(false);
  const loaded = calls.length;
  await app.press("id:uig-index-overlays");
  await app.waitFor("id:uig-demo-PopupSheet");
  await app.press("id:uig-popupsheet-open");
  await app.waitFor("id:uig-popupsheet-close");
  await app.press("id:uig-popupsheet-close");
  await app.waitFor("id:uig-popupsheet-close", { state: "gone" });
  await app.press("id:uig-language >> label:中文");
  await app.waitFor("text:UI 组件");
  expect(afterLoad(calls, loaded)).toEqual([]);
});
