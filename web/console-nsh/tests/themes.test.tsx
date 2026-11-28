// The console's themes: Aojashin (light) by default whatever the system's appearance, another when
// chosen in Settings › General › Change theme, kept on this device and applied before the first page
// shows. Each theme declares its own appearance; the status colours keep their meaning in each.
import { expect, test } from "nsh/test";
import { PAGE_COLORS, setPageColors, setThemeColor } from "../host.js";
import { DEFAULT_THEME, storedTheme, themeOf, themePageColors, THEMES } from "../lib/core/themes.js";
import theme from "../theme.json";
import { openConsole } from "./harness";

const KEY = "mistermorph.theme";
const LEGACY_KEY = "mistermorph.colorScheme";
const vars = (theme as { cssVars: Record<string, Record<string, string>> }).cssVars;
const varsOf = (id: string) => themeOf(id).vars as Record<string, string>;
const paper = (id: string) => `${varsOf(id).background.toLowerCase()}ff`;
const writes = (app: Awaited<ReturnType<typeof openConsole>>["app"]) =>
  app.host
    .calls()
    .filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === KEY)
    .map((call) => String((call.data as any)?.value));

/** The colours the app asked the browser to draw its chrome in (`theme-color`), in order. */
const chrome = (app: Awaited<ReturnType<typeof openConsole>>["app"]) =>
  app.host
    .calls()
    .filter((call) => call.name === "morph.themeColor")
    .map((call) => String((call.data as any)?.color).toLowerCase());
const bars = (id: string) => varsOf(id).nav.toLowerCase();
/** The themes the app named with those colours, for the page under it. */
const pages = (app: Awaited<ReturnType<typeof openConsole>>["app"]) =>
  app.host
    .calls()
    .filter((call) => call.name === "morph.themeColor")
    .map((call) => String((call.data as any)?.theme));

const SETTINGS = { location: "/e/default/settings/general" };
type App = Awaited<ReturnType<typeof openConsole>>["app"];
/** The app frame's background (App.tsx: `bg-paper`; its testID carries its bottom padding). */
function ground(app: App): string {
  for (let bottom = 0; bottom <= 120; bottom++) {
    const style = app.viewStyle(`id:app-frame.bottom-${bottom}`);
    if (style) return String(style.backgroundColor ?? "");
  }
  return "";
}

/** Opens the Themes dialog from Settings › General and chooses `id`. */
async function choose(app: App, id: string) {
  await app.press("id:settings-theme-change");
  await app.waitFor(`id:settings-theme-${id}`);
  await app.press(`id:settings-theme-${id}`);
  await app.waitUntil(() => ground(app) === paper(id));
  await app.press("id:settings-themes >> label:Close");
  await app.waitFor("id:settings-themes", { state: "gone" });
}

test("stage 1 has four themes, two light and two dark, and each has every token", () => {
  expect(THEMES.map((item) => `${item.id}:${item.scheme}`)).toEqual(["aojashin:light", "spqr:light", "midnight:dark", "bunko:dark"]);
  expect(DEFAULT_THEME).toBe("aojashin");
  const names = Object.keys(vars.light);
  for (const item of THEMES) expect(`${item.id} ${Object.keys(item.vars).sort().join()}`).toBe(`${item.id} ${[...names].sort().join()}`);
  // The app is built with Aojashin as its light palette and Midnight as its dark one.
  expect(themeOf("aojashin").vars).toEqual(vars.light);
  expect(themeOf("midnight").vars).toEqual(vars.dark);
  expect(vars.light.primary.toLowerCase()).toBe("#39587b");
  // The dark palette the console had before themes is gone.
  expect(vars.dark.background.toLowerCase()).not.toBe("#0f0f0f");
});

test("a device's stored choice names its theme; one that only chose dark before themes gets Midnight", () => {
  expect(storedTheme("bunko", "")).toBe("bunko");
  expect(storedTheme("SPQR", "dark")).toBe("spqr");
  expect(storedTheme("", "dark")).toBe("midnight");
  expect(storedTheme("", "light")).toBe("aojashin");
  expect(storedTheme("sepia", null)).toBe("aojashin");
  expect(themeOf("sepia").id).toBe("aojashin");
});

test("text and status colours keep their contrast in every theme", () => {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = (hex: string) => {
    const [r, g, b] = channels(hex).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const item of THEMES) {
    const v = item.vars as Record<string, string>;
    for (const ground of [v.background, v.card]) {
      for (const name of ["foreground", "subtle", "muted-foreground", "ink", "blue", "ok", "danger", "warn", "warn-dark", "info", "status-pending"]) {
        expect(`${item.id} ${name} ${contrast(v[name], ground) >= 4.5}`).toBe(`${item.id} ${name} true`);
      }
    }
    // What is written on a filled button.
    expect(contrast(v["primary-foreground"], v.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v["on-accent"], v.destructive)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v["on-accent"], v.warn)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v["on-accent"], v.blue)).toBeGreaterThanOrEqual(4.5);
    // The main navigation's own text, on its own fill (S.P.Q.R.'s is dark in a light theme).
    for (const name of ["mainnav-foreground", "mainnav-subtle", "mainnav-muted", "mainnav-icon"]) {
      expect(`${item.id} ${name} ${contrast(v[name], v.mainnav) >= 4.5}`).toBe(`${item.id} ${name} true`);
    }
  }
});

test("the console opens in Aojashin, also on a system that is dark", async () => {
  const { app } = await openConsole({ ...SETTINGS, colorScheme: "dark" });
  await app.waitFor("id:settings-theme");
  expect(ground(app)).toBe(paper("aojashin"));
  expect(app.shows("id:settings-theme >> text:Aojashin")).toBe(true);
  expect(app.shows("id:settings-theme >> text:Light")).toBe(true);
  // No appearance option: a theme is light or dark by itself.
  expect(app.shows("text:Appearance")).toBe(false);
  expect(app.count("id:settings-appearance")).toBe(0);
  expect(writes(app)).toEqual([]);
});

test("Settings shows the current theme only; the Themes dialog shows all four, grouped, and switches at once", async () => {
  const { app } = await openConsole(SETTINGS);
  await app.waitFor("id:settings-theme");
  expect(app.shows("id:settings-theme >> text:Slate blue on cool paper")).toBe(true);
  expect(app.shows("text:S.P.Q.R.")).toBe(false);
  await app.press("id:settings-theme-change");
  await app.waitFor("id:settings-themes");
  for (const item of THEMES) expect(app.shows(`id:settings-theme-${item.id}`)).toBe(true);
  expect(app.shows("id:settings-themes >> text:LIGHT · 2") || app.shows("id:settings-themes >> text:Light · 2")).toBe(true);
  expect(app.shows("id:settings-themes >> text:DARK · 2") || app.shows("id:settings-themes >> text:Dark · 2")).toBe(true);
  // The current one alone is ticked.
  expect(app.count("id:settings-theme-current")).toBe(1);
  expect(app.shows("id:settings-theme-aojashin >> id:settings-theme-current")).toBe(true);
  await app.press("id:settings-theme-bunko");
  await app.waitUntil(() => ground(app) === paper("bunko"));
  expect(app.shows("id:settings-theme-bunko >> id:settings-theme-current")).toBe(true);
  expect(app.count("id:settings-theme-current")).toBe(1);
  await app.press("id:settings-themes >> label:Close");
  await app.waitFor("id:settings-themes", { state: "gone" });
  expect(app.shows("id:settings-theme >> text:Bunkō")).toBe(true);
  expect(app.shows("id:settings-theme >> text:Dark")).toBe(true);
  expect(writes(app)).toEqual(["bunko"]);
  await choose(app, "spqr");
  await choose(app, "midnight");
  await choose(app, "aojashin");
  expect(writes(app)).toEqual(["bunko", "spqr", "midnight", "aojashin"]);
  expect(app.shows("id:settings-theme >> text:Aojashin")).toBe(true);
});

test("S.P.Q.R.'s main navigation is dark in a light theme, and reads on it", async () => {
  const { app } = await openConsole({ ...SETTINGS, kv: { [KEY]: "spqr" } });
  await app.waitFor("id:settings-theme");
  expect(ground(app)).toBe(paper("spqr"));
  expect(String(app.spanStyle("id:nav-settings >> text:Settings")?.color ?? "").toLowerCase()).toBe(`${varsOf("spqr")["mainnav-foreground"]}ff`);
});

test("the browser's theme-color follows the theme shown: at the start and at each switch, with no reload", async () => {
  const { app } = await openConsole(SETTINGS);
  await app.waitFor("id:settings-theme");
  expect(chrome(app)).toEqual([bars("aojashin")]);
  await choose(app, "midnight");
  await app.waitUntil(() => chrome(app).at(-1) === bars("midnight"));
  await choose(app, "aojashin");
  await app.waitUntil(() => chrome(app).at(-1) === bars("aojashin"));
  // Each call names its theme, so the page under the app changes with it.
  expect(pages(app).at(-1)).toBe("aojashin");
  expect(pages(app)).toContain("midnight");
  // A console that opens in a dark theme says so once, and never the light colour first.
  const dark = await openConsole({ ...SETTINGS, kv: { [KEY]: "midnight" } });
  await dark.app.waitFor("id:settings-theme");
  expect(chrome(dark.app)).toEqual([bars("midnight")]);
  expect(pages(dark.app)).toEqual(["midnight"]);
});

test("the page under the app takes the theme's colours on a switch: the ones it opens with, in one style kept last", () => {
  // What the markup gives the page at the start (scripts/build-web.sh), from the themes.
  expect(Object.keys(PAGE_COLORS)).toEqual(THEMES.map((item) => item.id).sort((x, y) => Object.keys(PAGE_COLORS).indexOf(x) - Object.keys(PAGE_COLORS).indexOf(y)));
  for (const item of THEMES) expect((PAGE_COLORS as Record<string, unknown>)[item.id]).toEqual(themePageColors(item));
  const head: any[] = [];
  const made: any[] = [];
  const doc = {
    querySelector: (selector: string) => (selector === "style[data-morph-page-colors]" ? (head.find((node) => "data-morph-page-colors" in node.attrs) ?? null) : null),
    createElement: (tag: string) => {
      const node = { tag, attrs: {} as Record<string, string>, textContent: "", setAttribute: (name: string, value: string) => void (node.attrs[name] = value) };
      made.push(node);
      return node;
    },
    // As the DOM does: appending a node that is there already moves it to the end.
    head: { appendChild: (node: any) => void (head.splice(0, head.length, ...head.filter((other) => other !== node), node)) },
  };
  head.push({ tag: "style", attrs: {}, textContent: "html, body { background: #eaf0f6; color: #17182b; }" });
  setPageColors("midnight", doc as any);
  expect(made).toHaveLength(1);
  expect(head[head.length - 1].textContent).toBe("html, body { background: #121822; color: #e6e9ef; }");
  // A later style of the page's does not outlast the next switch, and no second style is made.
  head.push({ tag: "style", attrs: {}, textContent: "html { background: red; }" });
  setPageColors("aojashin", doc as any);
  expect(made).toHaveLength(1);
  expect(head[head.length - 1].textContent).toBe("html, body { background: #eaf0f6; color: #17182b; }");
  expect(head).toHaveLength(3);
  // An unknown theme changes nothing.
  setPageColors("sepia", doc as any);
  setPageColors(undefined as any, doc as any);
  expect(head[head.length - 1].textContent).toBe("html, body { background: #eaf0f6; color: #17182b; }");
});

test("the web page's theme-color meta is rewritten in place, made when missing, and takes only a colour", () => {
  const made: Record<string, string>[] = [];
  const page = (meta: Record<string, string> | null) => {
    let found = meta && { attrs: meta, setAttribute: (name: string, value: string) => void (meta[name] = value) };
    return {
      querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? found : null),
      createElement: () => {
        const attrs: Record<string, string> = {};
        made.push(attrs);
        return { attrs, setAttribute: (name: string, value: string) => void (attrs[name] = value) };
      },
      head: { appendChild: (node: any) => void (found = node) },
    };
  };
  const existing = { name: "theme-color", content: "#eaf0f6" };
  setThemeColor("#141416", page(existing) as any);
  expect(existing.content).toBe("#141416");
  expect(made).toEqual([]);
  // Anything that is not a colour leaves the page as it is.
  for (const bad of ["", "red; background: url(x)", "javascript:alert(1)", undefined]) setThemeColor(bad as any, page(existing) as any);
  expect(existing.content).toBe("#141416");
  setThemeColor("#EAF0F6", page(null) as any);
  expect(made).toEqual([{ name: "theme-color", content: "#EAF0F6" }]);
});

test("a stored theme opens the console in it; a stored dark appearance from before themes opens Midnight; anything else Aojashin", async () => {
  const bunko = await openConsole({ ...SETTINGS, kv: { [KEY]: "bunko" } });
  await bunko.app.waitFor("id:settings-theme");
  expect(ground(bunko.app)).toBe(paper("bunko"));
  expect(bunko.app.shows("id:settings-theme >> text:Bunkō")).toBe(true);
  const legacy = await openConsole({ ...SETTINGS, kv: { [LEGACY_KEY]: "dark" } });
  await legacy.app.waitFor("id:settings-theme");
  expect(ground(legacy.app)).toBe(paper("midnight"));
  expect(legacy.app.shows("id:settings-theme >> text:Midnight")).toBe(true);
  const odd = await openConsole({ ...SETTINGS, kv: { [KEY]: "sepia" } });
  await odd.app.waitFor("id:settings-theme");
  expect(ground(odd.app)).toBe(paper("aojashin"));
});

test("the phone app keeps the choice in its storage and opens with it", async () => {
  const first = await openConsole({ ...SETTINGS, platform: "android" });
  await first.app.waitFor("id:settings-theme");
  await first.app.press("id:settings-theme-change");
  await first.app.waitFor("id:settings-theme-midnight");
  await first.app.press("id:settings-theme-midnight");
  await first.app.waitUntil(() => first.app.storage()[KEY] === "midnight");
  const again = await openConsole({ ...SETTINGS, platform: "android", kv: first.app.storage() });
  await again.app.waitFor("id:settings-theme");
  expect(ground(again.app)).toBe(paper("midnight"));
});

test("the theme is named in the console's languages", async () => {
  const { app } = await openConsole({ ...SETTINGS, kv: { "quail-language": "zh" } });
  await app.waitFor("id:settings-theme");
  expect(app.shows("id:settings-theme >> text:浅色")).toBe(true);
  expect(app.shows("id:settings-theme >> text:更换主题")).toBe(true);
  expect(app.shows("id:settings-theme >> text:冷色纸面上的石板蓝")).toBe(true);
});

test("the settings search finds the theme under Theme, and no longer offers Appearance", async () => {
  const { app } = await openConsole(SETTINGS);
  await app.waitFor("id:settings-theme");
  await app.type("id:settings-search", "Theme");
  await app.waitFor("id:settings-search-results");
  await app.waitFor("role:option[Theme]");
  await app.clear("id:settings-search");
  await app.type("id:settings-search", "Appearance");
  await app.wait(400);
  expect(app.count("role:option[Appearance]")).toBe(0);
});
