// The UI component gallery (/__ui-components, pages/ui-components): a testing page with a route and
// no navigation entry, guarded as any page, showing the console's reused UI components from
// synthetic data, in each language, without talking to the console or an agent; its head's Logout
// (lib/logout.ts) is its way out, to the login page.
import { expect, test } from "nsh/test";
import { LANGUAGES } from "../components/LanguageSelector";
import { createLogout } from "../lib/logout";
import { NAV_ITEMS_META } from "../lib/navOrder";
import { DEMOS } from "../pages/ui-components/demos";
import { GALLERY_ENTRIES, GALLERY_GROUPS } from "../pages/ui-components/inventory.js";
import { NSH_NAMES, TINT_HUES } from "../pages/ui-components/colorRules.js";
import theme from "../theme.json";
import { MOBILE_LOCATION_KEY, openConsole } from "./harness";

const PATH = "/__ui-components";
/** The gallery's address before it moved: an unknown address now, with no redirect. */
const OLD_PATH = "/ui-components";
const AUTH_KEY = "mistermorph_console_auth_v1";
/** A saved session, so a console that asks for a password opens the gallery at once. */
const session = () => ({
  [AUTH_KEY]: JSON.stringify({ token: "token-1", expiresAt: new Date(Date.now() + 86400000).toISOString(), account: "console" }),
});

type HostCalls = { host: { calls(): { name: string; data: any }[] } };
/** What the app wrote to the address bar, in order. */
const historyWrites = (app: HostCalls) => app.host.calls().filter((call) => call.name === "morph.history").map((call) => call.data as { op: string; url: string });
/** The last location the app wrote to the address bar. */
function lastLocation(app: HostCalls) {
  return String(historyWrites(app).at(-1)?.url || "");
}
/** What the app last saved under `key` on the web (`morph.kv.set`; null when it removed it), or undefined when it did not write it. */
function lastSaved(app: HostCalls, key: string) {
  const sets = app.host.calls().filter((call) => call.name === "morph.kv.set" && call.data?.key === key);
  return sets.length ? (sets.at(-1)!.data.value as string | null) : undefined;
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
/**
 * Brings a component's card to the top of the page by filtering for its name: a demo is mounted
 * only near the visible part of the page (pages/ui-components/UiComponentsPage.tsx `DemoCard`).
 */
async function find(app: { clear(selector: string): Promise<void>; type(selector: string, text: string): Promise<void>; waitFor(selector: string, options?: any): Promise<unknown> }, name: string, id = name) {
  await app.clear("id:uig-filter");
  await app.type("id:uig-filter", name);
  await app.waitFor(`id:uig-demo-${id}`);
  await app.waitFor(`id:uig-demo-away-${id}`, { state: "gone" });
}
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

test("the old address no longer opens the gallery: it is an unknown address, with no redirect", async () => {
  const { app } = await openConsole({ location: OLD_PATH });
  await app.waitFor(`text:${OLD_PATH}`);
  expect(app.shows("id:ui-components-page")).toBe(false);
  expect(app.shows("id:uig-title")).toBe(false);
  expect(historyWrites(app).some((write) => write.url.startsWith(PATH))).toBe(false);
  // The same without a session: the login page asks for the old address, not for the gallery.
  const locked = await openConsole({ location: OLD_PATH, password: true });
  await locked.app.waitFor("id:login-password");
  expect(lastLocation(locked.app)).toBe(`/login?redirect=${encodeURIComponent(OLD_PATH)}`);
  await locked.app.type("id:login-password", "secret");
  await locked.app.press("role:button[Login]");
  await locked.app.waitFor(`text:${OLD_PATH}`);
  expect(locked.app.shows("id:ui-components-page")).toBe(false);
});

test("Logout in the head logs out and lands on the login page, in place of the gallery", async () => {
  const { app, calls } = await openConsole({ location: PATH, password: true, kv: session() });
  await app.waitFor("id:ui-components-page");
  expect(app.enabled("id:uig-logout")).toBe(true);
  // The console's own label.
  expect(app.shows("id:uig-logout >> text:Logout")).toBe(true);
  const loaded = calls.length;
  await app.press("id:uig-logout");
  await app.waitFor("id:login-password");
  expect(app.shows("id:ui-components-page")).toBe(false);
  // One change asked of the console: it ends the session (the login page reads its own config).
  expect(afterLoad(calls, loaded).filter((request) => !request.startsWith("GET "))).toEqual(["POST /auth/logout"]);
  const headers = calls.slice(loaded).find((call) => call.path === "/auth/logout")?.headers ?? {};
  expect(headers.authorization || headers.Authorization).toBe("Bearer token-1");
  // The session is gone from the device, and the login page took the gallery's place.
  expect(lastSaved(app, AUTH_KEY)).toBe(null);
  expect(historyWrites(app).at(-1)).toEqual({ op: "replace", url: "/login" });
  // Back to the gallery's address: the guard asks for the password again.
  await app.host.send("morph.pop", { location: PATH });
  await app.waitFor("id:login-password");
  expect(app.shows("id:ui-components-page")).toBe(false);
  expect(lastLocation(app)).toBe(`/login?redirect=${encodeURIComponent(PATH)}`);
  await app.type("id:login-password", "secret");
  await app.press("role:button[Login]");
  await app.waitFor("id:ui-components-page");
  expect(lastLocation(app)).toBe(PATH);
});

test("a failed logout request still ends the session here and shows the login page", async () => {
  const { app, calls } = await openConsole({
    location: PATH,
    password: true,
    kv: session(),
    api: { "POST /auth/logout": { status: 500, body: { error: "logout failed" } } },
  });
  await app.waitFor("id:ui-components-page");
  await app.press("id:uig-logout");
  await app.waitFor("id:login-password");
  expect(calls.filter((call) => call.method === "POST" && call.path === "/auth/logout").length).toBe(1);
  expect(lastSaved(app, AUTH_KEY)).toBe(null);
  expect(historyWrites(app).at(-1)).toEqual({ op: "replace", url: "/login" });
  expect(app.shows("id:ui-components-page")).toBe(false);
});

test("on the phone, Logout also empties the answers kept on the device", async () => {
  // A first run of the phone app keeps the topics it was shown on the device.
  const api = { "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Trip plans", created_at: "2026-11-24T10:00:00Z", updated_at: "2026-11-24T10:00:00Z" }] } } };
  const first = await openConsole({ platform: "android", cacheFiles: true, password: true, kv: session(), location: "/e/default/chat", api });
  await first.app.waitFor("Trip plans");
  const files = (app: { storage(): Record<string, string> }) =>
    Object.keys(app.storage()).filter((key) => key.startsWith("cachefs:") && !key.endsWith("index.json"));
  await first.app.waitUntil(() => files(first.app).length >= 1, { timeout: 10000 });
  // Opened again on the gallery, with that session and those answers.
  const { app, calls } = await openConsole({
    platform: "android",
    cacheFiles: true,
    password: true,
    kv: { ...first.app.storage(), [MOBILE_LOCATION_KEY]: PATH },
    location: PATH,
    api,
  });
  await app.waitFor("id:ui-components-page");
  expect(files(app).length).toBeGreaterThanOrEqual(1);
  await app.press("id:uig-logout");
  await app.waitFor("id:login-password");
  expect(calls.filter((call) => call.method === "POST" && call.path === "/auth/logout").length).toBe(1);
  await app.waitUntil(() => files(app).length === 0, { timeout: 10000 });
  expect(app.storage()[AUTH_KEY]).toBeUndefined();
  expect(app.shows("id:ui-components-page")).toBe(false);
});

test("the logout control is busy while the logout runs: disabled, a second press does nothing, free again after", async () => {
  let runs = 0;
  let release = () => {};
  const control = createLogout(() => {
    runs += 1;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  expect(control.busy()).toBe(false);
  const first = control.run();
  expect(control.busy()).toBe(true);
  await control.run();
  expect(runs).toBe(1);
  release();
  await first;
  expect(control.busy()).toBe(false);
  // A logout that throws frees the control too.
  const failing = createLogout(() => Promise.reject(new Error("offline")));
  await expect(failing.run()).rejects.toThrow("offline");
  expect(failing.busy()).toBe(false);
});

test("Logout fits the head beside the appearance and language controls: on a 360pt and a 390pt phone and on a desktop, light and dark", async () => {
  const check = async (app: Awaited<ReturnType<typeof openConsole>>["app"]) => {
    await app.waitFor("id:ui-components-page");
    // No demo on the page: what is left of these texts is the head's.
    await app.type("id:uig-filter", "no such component");
    await app.waitFor("id:uig-empty");
    for (const scheme of ["Dark", "Light"]) {
      await app.press(`id:uig-appearance >> label:${scheme}`);
      // Laid out inside the window (a text past its right edge is not listed) and not covered.
      for (const text of ["UI components", "Light", "Dark", "English", "中文", "日本語", "Logout"]) expect(app.texts()).toContain(text);
      expect(app.shows("id:uig-logout")).toBe(true);
      expect(app.enabled("id:uig-logout")).toBe(true);
      expect(app.shows("id:uig-appearance")).toBe(true);
      expect(app.shows("id:uig-language")).toBe(true);
    }
  };
  for (const width of [360, 390]) await check((await openConsole({ location: PATH, platform: "android", width, height: 780 })).app);
  await check((await openConsole({ location: PATH })).app);
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

test("every inventory entry is on the page with its demo, and nothing else is", async () => {
  // The demos and the inventory name the same components.
  expect(GALLERY_ENTRIES.filter((entry) => !DEMOS[entry.id]).map((entry) => entry.id)).toEqual([]);
  expect(Object.keys(DEMOS).filter((id) => !GALLERY_ENTRIES.some((entry) => entry.id === id))).toEqual([]);
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  expect(app.shows(`text:${GALLERY_ENTRIES.length} components`)).toBe(true);
  for (const group of GALLERY_GROUPS) {
    expect(app.shows(`id:uig-group-${group.id}`)).toBe(true);
    expect(app.shows(`id:uig-index-${group.id}`)).toBe(true);
  }
  for (const entry of GALLERY_ENTRIES) expect(app.shows(`id:uig-demo-${entry.id}`)).toBe(true);
  // Only reused components are listed: a page's own part, a feature's part and the frame are not.
  for (const id of ["Sidebar", "ChatHistoryItem", "TodoTaskEditor", "SettingsPage"]) expect(app.count(`id:uig-demo-${id}`)).toBe(0);
  expect(app.count("text:Not mounted here")).toBe(0);
});

test("the colour scheme is on the page: every token with its value, in the appearance shown, which the page's own switch changes", async () => {
  const vars = (theme as { cssVars: Record<string, Record<string, string>> }).cssVars;
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  // A section of its own in the index: `All` is the components.
  expect(app.count("id:uig-group-colors")).toBe(0);
  await app.press("id:uig-index-colors");
  await app.waitFor("id:uig-group-colors");
  await app.waitFor("id:uig-group-controls", { state: "gone" });
  // Every token the two palettes share, each with the light palette's value.
  const names = Object.keys(vars.light).filter((name) => name in vars.dark);
  expect(app.shows(`id:uig-index-colors >> text:${names.length}`)).toBe(true);
  for (const name of names) expect(app.count(`id:uig-color-${name}`)).toBe(1);
  expect(app.shows(`id:uig-color-primary >> text:${vars.light.primary.toLowerCase()}`)).toBe(true);
  // nsh's names say which of the console's tokens to use; the console's own say only their value.
  for (const [name, ours] of Object.entries(NSH_NAMES)) expect(app.shows(`id:uig-color-${name} >> text:${vars.light[name].toLowerCase()} · use ${ours}`)).toBe(true);
  expect(app.count("id:uig-color-paper >> text:use")).toBe(0);
  // The tints: a row per colour, its fills and borders at each step.
  for (const hue of TINT_HUES) expect(app.count(`id:uig-tint-${hue}`)).toBe(1);
  expect(app.shows("id:uig-colors-tints >> text:hover on a tint")).toBe(true);
  // Dark is the console's own appearance: the values are the dark palette's, and the choice is kept.
  await app.press("id:uig-appearance >> text:Dark");
  await app.waitFor(`id:uig-color-primary >> text:${vars.dark.primary.toLowerCase()}`);
  expect(app.host.calls().filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === "mistermorph.colorScheme").map((call) => (call.data as any)?.value).at(-1)).toBe("dark");
  // The filter by a token's name.
  await app.type("id:uig-filter", "blue-l");
  await app.waitFor("id:uig-color-primary", { state: "gone" });
  expect(app.count("id:uig-color-blue-light")).toBe(1);
  expect(app.count("id:uig-color-blue-lighter")).toBe(1);
  expect(app.count("id:uig-colors-tints")).toBe(0);
  await app.press("id:uig-appearance >> text:Light");
  await app.waitFor(`id:uig-color-blue-light >> text:${vars.light["blue-light"].toLowerCase()}`);
  // The tints by their colour's name.
  await app.clear("id:uig-filter");
  await app.type("id:uig-filter", "dang");
  await app.waitFor("id:uig-tint-blue", { state: "gone" });
  expect(app.count("id:uig-tint-danger")).toBe(1);
});

test("only the demos near the visible part of the page are mounted, and scrolling mounts the next ones", async () => {
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  const demos = GALLERY_ENTRIES;
  const away = () => demos.filter((entry) => app.shows(`id:uig-demo-away-${entry.id}`)).map((entry) => entry.id);
  // The first card is there with its demo; the last section's are cards without one.
  await app.waitFor("id:uig-demo-away-Button", { state: "gone" });
  const last = demos.at(-1)!.id;
  expect(app.shows(`id:uig-demo-${last}`)).toBe(true);
  expect(away()).toContain(last);
  expect(away().length).toBeGreaterThan(demos.length / 2);
  // Far down the page the first card gives its demo up and keeps its place.
  const before = away().length;
  await app.scroll("id:uig-scroll", 6000);
  await app.waitFor("id:uig-demo-away-Button");
  expect(app.shows("id:uig-demo-Button")).toBe(true);
  expect(away().length).toBeLessThan(demos.length);
  expect(Math.abs(away().length - before)).toBeLessThan(demos.length / 2);
  await app.scroll("id:uig-scroll", -6000);
  await app.waitFor("id:uig-demo-away-Button", { state: "gone" });
  // Choosing a section shows it from its start, wherever the page was.
  await app.scroll("id:uig-scroll", 6000);
  await app.waitFor("id:uig-demo-away-Button");
  await app.press("id:uig-index-controls");
  await app.waitFor("id:uig-group-feedback", { state: "gone" });
  await app.waitFor("id:uig-demo-away-Button", { state: "gone" });
});

test("the index shows one section, the filter finds components by name or file, and an empty result says how to get back", async () => {
  const { app } = await openConsole({ location: PATH });
  await app.waitFor("id:ui-components-page");
  await app.press("id:uig-index-motion");
  await app.waitFor("id:uig-group-controls", { state: "gone" });
  expect(app.shows("id:uig-group-motion")).toBe(true);
  expect(app.shows("id:uig-demo-FadeText")).toBe(true);
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
  const named = GALLERY_ENTRIES.filter((entry) => [entry.name, entry.id, entry.file].some((text) => text.toLowerCase().includes("composer"))).length;
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
  // A production component's string.
  const examples = async (save: string) => {
    await find(app, "Button");
    expect(app.shows(`id:uig-demo-Button >> text:${save}`)).toBe(true);
    await app.clear("id:uig-filter");
  };
  // English: the page's own strings and a production component's string.
  await examples("Save");
  await app.press("id:uig-language >> label:中文");
  await app.waitFor("text:UI 组件");
  expect(app.shows(`text:${GALLERY_ENTRIES.length} 个组件`)).toBe(true);
  await examples("保存");
  await app.press("id:uig-language >> label:日本語");
  await app.waitFor("text:UI コンポーネント");
  await examples("保存");
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
  await find(app, "Button");
  await app.press("id:uig-button-danger");
  await app.waitFor("text:Last local action: Button: danger (1 so far)");
  // The demo shows text buttons and icon buttons apart, none with both: the icon button of a
  // variant is named for its tooltip and draws no label, and the selected example is a glyph.
  await app.press("id:uig-button-icon-danger");
  await app.waitFor("text:Last local action: Button: danger (2 so far)");
  expect(app.count("id:uig-button-selected")).toBe(1);
  // The outlined danger button sits beside the others, as a text and an icon button, and in every
  // size; its glyphs are red (their test ids name the tint).
  await app.press("id:uig-button-outlined-danger");
  await app.waitFor("text:Last local action: Button: outlined-danger (3 so far)");
  await app.press("id:uig-button-icon-outlined-danger");
  await app.waitFor("text:Last local action: Button: outlined-danger (4 so far)");
  expect(app.count("id:uig-button-icon-outlined-danger-glyph.danger")).toBe(1);
  for (const size of ["md", "sm", "xs", "xxs"]) {
    expect(app.count(`id:uig-button-outlined-danger-${size}`)).toBe(1);
    expect(app.count(`id:uig-button-outlined-danger-icon-${size}-glyph.danger`)).toBe(1);
  }
  expect(app.count("id:uig-button-outlined-danger-selected")).toBe(1);
  expect(app.count("label:Sample switch")).toBeGreaterThan(0);
  expect(app.texts()).not.toContain("Sample switch");
  expect(app.shows("id:uig-button-icon-busy-loading")).toBe(true);
  await find(app, "Toggle");
  expect(app.shows("text:On")).toBe(true);
  await app.press("id:uig-toggle");
  await app.waitFor("text:Off");
  await find(app, "TextField");
  await app.type("id:uig-textfield-name", "Quill");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("Value: ") && text.includes("Quill")));
  await find(app, "ProgressBar");
  await app.press("id:uig-progress-more");
  await app.waitFor("text:50% done");

  // A dialog, a message and a notice: each opens and closes.
  await find(app, "Modal");
  await app.press("id:uig-modal-open-md");
  await app.waitFor("id:uig-modal");
  await app.press("id:uig-modal-cancel");
  await app.waitFor("id:uig-modal", { state: "gone" });
  await find(app, "MessageDialog");
  await app.press("id:uig-message-open-danger");
  await app.waitFor("id:uig-message");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:uig-message", { state: "gone" });
  // The inline notice demos show the same sentence twice already; the notice stack adds one.
  await find(app, "NoticeHost");
  const NOTICE = "A sample warning notice from the gallery.";
  const shownNotices = () => app.texts().filter((text) => text === NOTICE).length;
  const inline = shownNotices();
  await app.press("id:uig-notice-warning");
  await app.waitUntil(() => shownNotices() === inline + 1);
  await app.press("id:uig-notice-clear");
  await app.waitUntil(() => shownNotices() === inline);
  await find(app, "DialogShell");
  await app.press("id:uig-dialog-DialogShell");
  await app.waitFor("id:uig-dialogshell");
  await app.press("id:uig-dialogshell-done");
  await app.waitFor("id:uig-dialogshell", { state: "gone" });

  // What would send, save or approve in the console only notes the action here.
  await find(app, "ChatComposer");
  await app.type("id:uig-composer-default >> id:chat-composer-input", "hello from the gallery");
  await app.press("id:uig-composer-default >> id:chat-composer-send");
  await app.waitUntil(() => app.texts().some((text) => text.includes("ChatComposer send: hello from the gallery")));

  expect(afterLoad(calls, loaded)).toEqual([]);
  expect(writes(calls)).toEqual([]);
  expect(lastLocation(app)).toBe(PATH);
});

test("on a phone the gallery is one column inside the window, and its dialogs open and close", async () => {
  const { app, calls } = await openConsole({ location: PATH, platform: "android" });
  await app.waitFor("id:ui-components-page");
  await app.waitFor("id:uig-demo-Button");
  expect(app.shows("id:mobile-bottom-nav")).toBe(false);
  const loaded = calls.length;
  await app.press("id:uig-index-overlays");
  await app.waitFor("id:uig-demo-Modal");
  await app.press("id:uig-modal-open-md");
  await app.waitFor("id:uig-modal");
  await app.press("id:uig-modal-cancel");
  await app.waitFor("id:uig-modal", { state: "gone" });
  await app.press("id:uig-language >> label:中文");
  await app.waitFor("text:UI 组件");
  expect(afterLoad(calls, loaded)).toEqual([]);
});
