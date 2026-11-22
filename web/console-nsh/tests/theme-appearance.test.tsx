// The console's appearance: light by default whatever the system's, dark when chosen in Settings →
// General, kept on this device and applied before the first page shows. theme.json carries both
// palettes; the status colours keep their meaning in each.
import { expect, test } from "nsh/test";
import { PAGE_COLORS, setPageColors, setThemeColor } from "../host.js";
import theme from "../theme.json";
import { openConsole } from "./harness";

const KEY = "mistermorph.colorScheme";
const vars = (theme as { cssVars: Record<string, Record<string, string>> }).cssVars;
const paper = (scheme: "light" | "dark") => `${vars[scheme].background.toLowerCase()}ff`;
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
const bars = (scheme: "light" | "dark") => vars[scheme].nav.toLowerCase();
/** The themes the app named with those colours, for the page under it. */
const pages = (app: Awaited<ReturnType<typeof openConsole>>["app"]) =>
  app.host
    .calls()
    .filter((call) => call.name === "morph.themeColor")
    .map((call) => String((call.data as any)?.scheme));

const SETTINGS = { location: "/e/default/settings/general" };
type App = Awaited<ReturnType<typeof openConsole>>["app"];
/** The app frame's background (App.tsx: `bg-background`; its testID carries its bottom padding). */
function ground(app: App): string {
  for (let bottom = 0; bottom <= 120; bottom++) {
    const style = app.viewStyle(`id:app-frame.bottom-${bottom}`);
    if (style) return String(style.backgroundColor ?? "");
  }
  return "";
}

test("the two palettes have the same tokens and differ", () => {
  expect(Object.keys(vars.dark)).toEqual(Object.keys(vars.light));
  expect(vars.dark.background.toLowerCase()).not.toBe(vars.light.background.toLowerCase());
  expect(vars.dark.foreground.toLowerCase()).not.toBe(vars.light.foreground.toLowerCase());
  // The status colours of the dark palette are the pastels themselves.
  expect([vars.dark.warn, vars.dark.ok, vars.dark.danger, vars.dark["status-on"], vars.dark["status-pending"]].map((c) => c.toLowerCase())).toEqual([
    "#ffc48a",
    "#6fd8ee",
    "#ff9f86",
    "#9fc6ff",
    "#f4e97a",
  ]);
  // Primary is the navy blue in the light palette.
  expect(vars.light.primary.toLowerCase()).toBe("#39587b");
});

test("text and status colours keep their contrast on both palettes", () => {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = (hex: string) => {
    const [r, g, b] = channels(hex).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const scheme of ["light", "dark"] as const) {
    const v = vars[scheme];
    for (const ground of [v.background, v.card]) {
      for (const name of ["foreground", "subtle", "muted-foreground", "ink", "blue", "ok", "danger", "warn", "warn-dark", "status-on", "status-pending", "info"]) {
        expect(`${scheme} ${name} ${contrast(v[name], ground) >= 4.5}`).toBe(`${scheme} ${name} true`);
      }
    }
    // What is written on a filled button.
    expect(contrast(v["primary-foreground"], v.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v["destructive-foreground"], v.destructive)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v["warn-foreground"], v.warn)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v["on-accent"], v.blue)).toBeGreaterThanOrEqual(4.5);
  }
});

test("the console opens light, also on a system that is dark", async () => {
  const { app } = await openConsole({ ...SETTINGS, colorScheme: "dark" });
  await app.waitFor("id:settings-appearance");
  expect(ground(app)).toBe(paper("light"));
  expect(app.shows("id:settings-appearance >> text:Light")).toBe(true);
  expect(writes(app)).toEqual([]);
});

test("Settings switches to dark and back at once, and keeps the choice", async () => {
  const { app } = await openConsole(SETTINGS);
  await app.waitFor("id:settings-appearance");
  expect(app.shows("text:Appearance")).toBe(true);
  await app.press("id:settings-appearance");
  await app.press("text:Dark");
  await app.waitUntil(() => ground(app) === paper("dark"));
  expect(app.shows("id:settings-appearance >> text:Dark")).toBe(true);
  expect(writes(app)).toEqual(["dark"]);
  await app.press("id:settings-appearance");
  await app.press("text:Light");
  await app.waitUntil(() => ground(app) === paper("light"));
  expect(writes(app)).toEqual(["dark", "light"]);
});

test("the browser's theme-color follows the theme shown: at the start and at each switch, with no reload", async () => {
  // The page's markup (scripts/build-web.sh) sets these two before the app draws; they are the bars' own.
  expect([bars("light"), bars("dark")]).toEqual(["#eaf0f6", "#141416"]);
  const { app } = await openConsole(SETTINGS);
  await app.waitFor("id:settings-appearance");
  expect(chrome(app)).toEqual([bars("light")]);
  await app.press("id:settings-appearance");
  await app.press("text:Dark");
  await app.waitUntil(() => chrome(app).length === 2);
  expect(chrome(app)).toEqual([bars("light"), bars("dark")]);
  await app.press("id:settings-appearance");
  await app.press("text:Light");
  await app.waitUntil(() => chrome(app).length === 3);
  expect(chrome(app)[2]).toBe(bars("light"));
  // Each call names its theme, so the page under the app changes with it.
  expect(pages(app)).toEqual(["light", "dark", "light"]);
  // A console that opens dark says so once, and never the light colour first.
  const dark = await openConsole({ ...SETTINGS, kv: { [KEY]: "dark" } });
  await dark.app.waitFor("id:settings-appearance");
  expect(chrome(dark.app)).toEqual([bars("dark")]);
  expect(pages(dark.app)).toEqual(["dark"]);
});

test("the page under the app takes the theme's colours on a switch: the ones it opens with, in one style kept last", () => {
  // What the markup gives the page at the start (scripts/build-web.sh), from the palettes.
  expect(PAGE_COLORS.light).toEqual({ background: vars.light.nav.toLowerCase(), color: vars.light.foreground.toLowerCase() });
  expect(PAGE_COLORS.dark).toEqual({ background: vars.dark.background.toLowerCase(), color: vars.dark.foreground.toLowerCase() });
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
  setPageColors("dark", doc as any);
  expect(made).toHaveLength(1);
  expect(head[head.length - 1].textContent).toBe("html, body { background: #0f0f0f; color: #f3f3f6; }");
  // A later style of the page's does not outlast the next switch, and no second style is made.
  head.push({ tag: "style", attrs: {}, textContent: "html { background: red; }" });
  setPageColors("light", doc as any);
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

test("a stored dark choice opens the console dark, and anything else light", async () => {
  const dark = await openConsole({ ...SETTINGS, kv: { [KEY]: "dark" } });
  await dark.app.waitFor("id:settings-appearance");
  expect(ground(dark.app)).toBe(paper("dark"));
  expect(dark.app.shows("id:settings-appearance >> text:Dark")).toBe(true);
  const odd = await openConsole({ ...SETTINGS, kv: { [KEY]: "sepia" } });
  await odd.app.waitFor("id:settings-appearance");
  expect(ground(odd.app)).toBe(paper("light"));
});

test("the phone app keeps the choice in its storage and opens with it", async () => {
  const first = await openConsole({ ...SETTINGS, platform: "android" });
  await first.app.waitFor("id:settings-appearance");
  await first.app.press("id:settings-appearance");
  await first.app.press("text:Dark");
  await first.app.waitUntil(() => first.app.storage()[KEY] === "dark");
  const again = await openConsole({ ...SETTINGS, platform: "android", kv: first.app.storage() });
  await again.app.waitFor("id:settings-appearance");
  expect(ground(again.app)).toBe(paper("dark"));
});

test("the appearance is named in the console's languages", async () => {
  const { app } = await openConsole({ ...SETTINGS, kv: { "quail-language": "zh" } });
  await app.waitFor("id:settings-appearance");
  expect(app.shows("text:外观")).toBe(true);
  expect(app.shows("id:settings-appearance >> text:浅色")).toBe(true);
});
