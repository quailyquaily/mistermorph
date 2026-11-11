// Android's Back while a page or a pane is still sliding out (components/frame/PageStack.tsx,
// components/motion/PaneStack.tsx, lib/systemBack.ts), in the whole console with its slides
// stretched to a minute (tests/slowSlidesConsole.tsx), so each step acts mid-slide:
// - a settings section going back to the sections keeps showing that section as it slides out,
//   never the sections' own (Persona);
// - a page going out no longer takes Back: Back goes to the place before (the history), not to
//   what the outgoing page's own back arrow did.
// A resize ends a running slide at once (both hosts), which the tests use to let one end.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { PANE_ARRIVAL_MS } from "../components/motion/PaneStack";
import { MOBILE_LOCATION_KEY, openConsole } from "./harness";

const EMPTY = { body: { items: [] } };
const QUIET = { "GET /proxy:/todo/tasks": EMPTY, "GET /proxy:/tasks": EMPTY, "GET /proxy:/topics": EMPTY };
const SKILLS = {
  "GET /settings/agent/skills/store": { status: 404, body: { error: "not found" } },
  "GET /settings/agent/skills/detail": { body: { content: "# Weather skill\n", revision: "doc-1" } },
  "GET /settings/agent/skills": {
    body: {
      enabled: true,
      load: [],
      roots: ["/home/me/.morph/skills"],
      config_revision: "rev-1",
      skills: [{ id: "weather", name: "Weather", description: "Forecasts", dir: "/home/me/.morph/skills/weather", loaded: true, files: [] }],
    },
  },
};

const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");

/** Ends the running slides at once: a change of the window's size does (as a rotation would). */
async function endSlides(app: App, height: number) {
  await app.setViewport(390, height);
}

/** Back with nothing in the app to take it: the system's own back, which leaves the app. */
async function expectSystemBack(app: App) {
  await expect(app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
}

async function openSystemSection() {
  const { app } = await openConsole({ platform: "android", location: "/e/default/settings", api: QUIET, slowSlides: true });
  await app.waitFor("id:settings-section-system");
  // Past the page's arrival: opening a section now slides it in (PaneStack).
  await app.wait(PANE_ARRIVAL_MS + 100);
  await app.press("id:settings-section-system");
  await app.waitUntil(() => location(app) === "/e/default/settings/system");
  await app.waitFor("id:settings-open-logs");
  return app;
}

/** The section pane is sliding out over the sections, still showing System, never Persona. */
function expectSystemGoingOut(app: App) {
  expect(location(app)).toBe("/e/default/settings");
  expect(app.count("id:settings-index")).toBe(1);
  expect(app.count("id:settings-panel")).toBe(1);
  expect(app.count("id:settings-open-logs")).toBe(1);
  expect(app.count("id:settings-persona")).toBe(0);
}

test("Back from a settings section slides that section out, not the sections' first one", async () => {
  const app = await openSystemSection();
  await endSlides(app, 843);
  await app.waitFor("id:settings-index", { state: "gone" });

  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/settings");
  expectSystemGoingOut(app);

  await endSlides(app, 844);
  await app.waitFor("id:settings-panel", { state: "gone" });
  expect(app.count("id:settings-persona")).toBe(0);
  expect(app.count("id:settings-index")).toBe(1);
  // The section left the history with it: the next Back leaves the app.
  await expectSystemBack(app);
});

test("Back while a settings section still slides in turns it round with that section on it", async () => {
  const app = await openSystemSection();
  // The section's slide in is still running.
  expect(app.count("id:settings-index")).toBe(1);

  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/settings");
  expectSystemGoingOut(app);

  await endSlides(app, 843);
  await app.waitFor("id:settings-panel", { state: "gone" });
  expect(app.count("id:settings-persona")).toBe(0);
  await expectSystemBack(app);
});

test("a page going out does not take Back: it goes to the place before, not the outgoing page's own back", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/skills?skill=weather", api: { ...QUIET, ...SKILLS }, slowSlides: true });
  await app.waitFor("id:skill-detail");
  await app.waitUntil(() => location(app) === "/e/default/skills?skill=weather");

  await app.press("id:mobile-nav-todo");
  await app.waitUntil(() => location(app) === "/e/default/todo");
  await app.waitFor("id:todo-page");
  // Skills, with its skill and the skill's back arrow, is still sliding out.
  expect(app.count("id:page-layer-out")).toBe(1);
  expect(app.count("id:skill-detail")).toBe(1);

  await app.back();
  // The history's Back, as after the slide: Skills with its skill again (closing the outgoing
  // skill instead would have left the address on TODO).
  await app.waitUntil(() => location(app) === "/e/default/skills?skill=weather");
  await endSlides(app, 843);
  await app.waitFor("id:todo-page", { state: "gone" });
  await app.waitFor("id:skill-detail");
  expect(app.count("id:page-layer-out")).toBe(0);
});
