// The workspace folder picker (components/shared/WorkspaceDirPickerDialog.tsx) on phones and
// desktops. On a phone (the console's mobile layout, up to 980pt) its places are the shared Tabs:
// Recent, Home and System, then the runtime's state and cache folders when it reports them, in one
// row across the dialog that scrolls sideways when they do not fit, never wider than the dialog. A
// tap on a place shows its folders (or the recent ones) as the sidebar did, selecting the place's own
// folder; the tab comes fully into view; a swipe along the row picks nothing. A desktop keeps the
// sidebar: a column of place buttons under the PLACES caption, no tabs. The dialog's content
// (loading, errors, creating a folder, confirming) is tests/todo.test.tsx's (the TODO page's
// picker); the tabs themselves: tests/tab-strip.test.tsx. Fixture:
// tests/fixtures/workspace-dir-picker-app.tsx.
import type { App, StubRequest, StubResponse } from "nsh/test";
import { expect, open, test } from "nsh/test";

type Box = { x: number; w: number };
type Strip = { viewport: number; content: number; offset: number; scrolls: boolean; value: string; boxes: Record<string, Box> };

const STATE = "/home/u/.morph";
const CACHE = "/home/u/.cache/mistermorph";
const PLACES = ["Recent", "Home", "System", "State Dir", "Cache Dir"];

/** The folders each browsed path holds; `fail` paths answer an error. */
const TREE: Record<string, { name: string; path: string; is_dir: boolean; has_children?: boolean }[]> = {
  "~": [
    { name: "projects", path: "/home/u/projects", is_dir: true, has_children: true },
    { name: "notes.txt", path: "/home/u/notes.txt", is_dir: false },
  ],
  "": [
    { name: "etc", path: "/etc", is_dir: true },
    { name: "home", path: "/home", is_dir: true },
  ],
  [STATE]: [{ name: "persona", path: `${STATE}/persona`, is_dir: true }],
  [CACHE]: [{ name: "artifacts", path: `${CACHE}/artifacts`, is_dir: true }],
};

async function openPicker(options: { width: number; height?: number; platform?: "linux" | "android"; places?: boolean; fail?: string[]; recent?: string[] }) {
  const browsed: string[] = [];
  const app = await open("./fixtures/workspace-dir-picker-app.tsx", {
    width: options.width,
    height: options.height ?? 760,
    platform: "linux",
    locale: "en-US",
    host: {
      handlers: {
        "morph.boot": {
          runtime: "web",
          origin: "http://console.test",
          basePath: "/",
          location: "/",
          kv: {
            "quail-language": "en",
            mistermorph_console_recent_workspaces_v1: JSON.stringify(options.recent ?? ["/home/u/projects/morph"]),
          },
          session: {},
          languages: ["en-US"],
          desktopVersion: "",
          features: [],
        },
        "morph.kv.set": null,
      },
    },
    network: Object.fromEntries(["GET", "POST"].map((method) => [`${method} *`, answer])),
  });
  await app.press("id:open-picker");
  await app.waitFor("id:workspace-dir-picker");
  await app.waitFor("text:projects");
  return { app, browsed };

  function answer(raw: StubRequest): StubResponse {
    const url = new URL(raw.url);
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/endpoints") {
      return { body: { items: [{ endpoint_ref: "ep_console_local", name: "Console", url: "in-process://console-local", connected: true, mode: "console" }] } };
    }
    const uri = new URL(`http://x${url.searchParams.get("uri") ?? ""}`);
    if (path === "/proxy" && uri.pathname === "/workspace/browse") {
      const dir = uri.searchParams.get("path") ?? "";
      browsed.push(dir);
      if (options.fail?.includes(dir)) return { status: 500, body: { error: `cannot read ${dir}` } };
      const places = options.places === false ? {} : { state_dir: STATE, cache_dir: CACHE };
      return { body: { ...places, items: TREE[dir] ?? [] } };
    }
    return { status: 404, body: { error: `no stub for ${path} ${uri.pathname}` } };
  }
}

function strip(app: App): Strip | undefined {
  const text = app.texts().find((item) => item.startsWith("{")) ?? "{}";
  return (JSON.parse(text) as Record<string, Strip>)["workspace-sources"];
}

/** The option `id` lies wholly in the strip's viewport. */
function inView(s: Strip, id: string) {
  const box = s.boxes[id];
  return { id, inView: box.x >= s.offset - 0.5 && box.x + box.w <= s.offset + s.viewport + 0.5 };
}

const createIn = (app: App) => app.texts().find((text) => text.startsWith("/") || text === "No directory selected") ?? "";

test("on a phone the places are tabs, Recent to Cache Dir, the current one Home, in a row the dialog's width", async () => {
  const { app } = await openPicker({ width: 390 });
  await app.waitUntil(() => Boolean(strip(app)?.boxes.cache_dir));
  for (const label of PLACES) expect({ label, tab: app.count(`role:tab[${label}]`) }).toEqual({ label, tab: 1 });
  expect(app.count("id:workspace-sources")).toBe(1);
  expect(app.shows("label:Places")).toBe(true);
  // No sidebar caption: the tab list carries the name.
  expect(app.texts().includes("PLACES") || app.texts().includes("Places")).toBe(false);
  const s = strip(app)!;
  expect(s.value).toBe("home");
  // In order, end to end, each as wide as its label.
  const order = ["recent", "home", "system", "state_dir", "cache_dir"];
  order.slice(1).forEach((id, index) => expect(s.boxes[id].x).toBe(s.boxes[order[index]].x + s.boxes[order[index]].w));
  expect(s.boxes.recent.x).toBe(0);
  // The row spans the dialog's content: the phone paper less its padding, never more.
  expect(s.viewport).toBeGreaterThan(300);
  expect(s.viewport).toBeLessThanOrEqual(390 - 32);
});

test("on a narrow phone the places scroll sideways in a row no wider than the dialog, Home shown at first", async () => {
  const { app } = await openPicker({ width: 320 });
  await app.waitUntil(() => Boolean(strip(app)?.boxes.cache_dir));
  const s = strip(app)!;
  expect(s.scrolls).toBe(true);
  expect(s.content).toBeGreaterThan(s.viewport);
  expect(s.viewport).toBeLessThanOrEqual(320 - 32);
  expect(app.count("id:workspace-sources-scroll")).toBe(1);
  expect(inView(s, "home")).toEqual({ id: "home", inView: true });
  // The last place is off the edge until the row moves.
  expect(inView(s, "cache_dir")).toEqual({ id: "cache_dir", inView: false });
});

test("a tap on a place offscreen browses it and brings its tab into view; a swipe along the row picks nothing", async () => {
  const { app, browsed } = await openPicker({ width: 320 });
  await app.waitUntil(() => Boolean(strip(app)?.boxes.cache_dir));
  // A swipe to the end and back: no place loads.
  const before = browsed.length;
  await app.drag("id:workspace-sources-scroll", { x: -400 });
  await app.wait(200);
  const swiped = strip(app)!;
  expect(swiped.offset).toBeGreaterThan(0);
  expect(inView(swiped, "cache_dir")).toEqual({ id: "cache_dir", inView: true });
  await app.drag("id:workspace-sources-scroll", { x: 400 });
  await app.wait(200);
  expect(strip(app)!.offset).toBe(0);
  expect(browsed.length).toBe(before);
  expect(strip(app)!.value).toBe("home");
  // The cache folder: its folders, the place's own folder selected.
  await app.press("id:workspace-source-cache_dir");
  await app.waitFor("text:artifacts");
  expect(browsed.at(-1)).toBe(CACHE);
  await app.waitUntil(() => createIn(app) === CACHE);
  expect(app.enabled("id:workspace-confirm")).toBe(true);
  await app.waitUntil(() => strip(app)!.value === "cache_dir" && inView(strip(app)!, "cache_dir").inView);
  // Back to System: the root's folders, nothing selected; its tab comes back in.
  await app.press("id:workspace-source-system");
  await app.waitFor("text:etc");
  expect(browsed.at(-1)).toBe("");
  await app.waitUntil(() => strip(app)!.value === "system" && inView(strip(app)!, "system").inView);
  expect(app.enabled("id:workspace-confirm")).toBe(false);
  // Recent: the remembered folders, no request.
  const loads = browsed.length;
  await app.press("id:workspace-source-recent");
  // (A `text:` selector starting with "/" is a regex.)
  await app.waitUntil(() => app.texts().includes("/home/u/projects/morph"));
  expect(browsed.length).toBe(loads);
  await app.waitUntil(() => strip(app)!.offset === 0);
  // Picking a recent folder and confirming reports it.
  await app.press("id:workspace-row-/home/u/projects/morph");
  await app.press("id:workspace-confirm");
  await app.waitUntil(() => app.texts().includes("confirmed=/home/u/projects/morph"));
});

test("a place that cannot be read shows the error; with no recent folders Recent says so", async () => {
  const { app } = await openPicker({ width: 320, fail: [STATE], recent: [] });
  await app.press("id:workspace-source-state_dir");
  await app.waitUntil(() => app.texts().includes(`cannot read ${STATE}`));
  await app.press("id:workspace-source-recent");
  await app.waitFor("text:No recent workspaces yet.");
});

test("without state and cache folders the phone's tabs are the three fixed places", async () => {
  const { app } = await openPicker({ width: 390, places: false });
  await app.waitUntil(() => Boolean(strip(app)?.boxes.system));
  expect(Object.keys(strip(app)!.boxes)).toEqual(["recent", "home", "system"]);
  expect(app.count("role:tab[State Dir]")).toBe(0);
  expect(strip(app)!.scrolls).toBe(false);
  expect(app.count("id:workspace-sources-scroll")).toBe(0);
});

test("a desktop keeps the places sidebar: buttons under the PLACES caption, no tabs", async () => {
  const { app, browsed } = await openPicker({ width: 1280 });
  await app.waitFor("id:workspace-source-cache_dir");
  expect(app.count("id:workspace-sources")).toBe(0);
  expect(strip(app)).toBe(undefined);
  for (const label of PLACES) expect({ label, tab: app.count(`role:tab[${label}]`) }).toEqual({ label, tab: 0 });
  expect(app.texts()).toContain("PLACES");
  for (const id of ["recent", "home", "system", "state_dir", "cache_dir"]) expect(app.count(`id:workspace-source-${id}`)).toBe(1);
  await app.press("id:workspace-source-state_dir");
  await app.waitFor("text:persona");
  expect(browsed.at(-1)).toBe(STATE);
  await app.waitUntil(() => createIn(app) === STATE);
});
