// The composer's model picker as it sits closed: the chosen profile's mark and name on desktop
// widths, the mark alone at phone widths (lib/shell's MOBILE_BREAKPOINT), following resizes and
// rotations. Its accessible name, its menu (names included) and the choice stay the same on both.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { MOBILE_BREAKPOINT } from "../lib/shell";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
// The default route runs an OpenAI model (its logo); "house" a model of no known vendor (the chip).
const PROFILES = {
  body: {
    default: { model: "gpt-5.2", provider: "openai" },
    items: [
      { name: "cheap", model: "gpt-5-mini", provider: "openai" },
      { name: "house", model: "house-model-7", provider: "openai_custom" },
    ],
  },
};
const NAME = "id:chat-composer-profile-name";
const LOGO = "id:chat-composer-profile-icon.image";
const CHIP = "id:chat-composer-profile-icon.PhCpu";

function api(sent: { body: any }) {
  return {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": { body: { items: [] } },
    "GET /proxy:/llm/profiles": PROFILES,
    "POST /proxy:/tasks": (request: ApiRequest) => {
      sent.body = request.json;
      return { status: 500, body: { error: "queue full" } };
    },
  };
}

/** The picker shows the mark of the profile labelled `title`, and its name only when `named`. */
function expectPicker(app: App, title: string, mark: string, named: boolean) {
  expect(app.count(`label:LLM profile: ${title}`)).toBe(1);
  expect(app.count(mark)).toBe(1);
  expect(app.count(NAME)).toBe(named ? 1 : 0);
  if (named) expect(app.texts()).toContain(title);
}

/** Opens the picker, checks every profile is named in its menu, and picks `title`. */
async function pick(app: App, from: string, title: string) {
  await app.press(`label:LLM profile: ${from}`);
  for (const name of ["Default", "cheap", "house"]) await app.waitFor(`text:${name}`);
  expect(app.texts()).toContain("gpt-5-mini");
  await app.press(`text:${title}`);
  await app.waitFor(`label:LLM profile: ${title}`);
}

test("on a desktop the closed picker shows the profile's mark and name, and a new choice shows its own", async () => {
  const sent = { body: null as any };
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: api(sent) });
  await app.waitFor("id:chat-composer-profile");
  expectPicker(app, "Default", LOGO, true);
  await pick(app, "Default", "house");
  expectPicker(app, "house", CHIP, true);
  expect(app.texts()).not.toContain("Default");
  // The choice still goes with the task.
  await app.type("id:chat-composer-input", "hello");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => sent.body !== null);
  expect(sent.body.llm_profile).toBe("house");
});

test("at phone widths the closed picker shows the mark alone, its menu still names every profile", async () => {
  const sent = { body: null as any };
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", width: 390, height: 844, api: api(sent) });
  await app.waitFor("id:chat-composer-profile");
  expectPicker(app, "Default", LOGO, false);
  await pick(app, "Default", "house");
  expectPicker(app, "house", CHIP, false);
  await pick(app, "house", "cheap");
  expectPicker(app, "cheap", LOGO, false);
  await app.type("id:chat-composer-input", "hello");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => sent.body !== null);
  expect(sent.body.llm_profile).toBe("cheap");
});

test("the name goes and comes back as the window crosses the phone breakpoint or the phone turns", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: api({ body: null }) });
  await app.waitFor("id:chat-composer-profile");
  await pick(app, "Default", "house");
  expectPicker(app, "house", CHIP, true);
  // Down to the breakpoint itself: a phone's layout.
  await app.setViewport(MOBILE_BREAKPOINT + 1, 800);
  expectPicker(app, "house", CHIP, true);
  await app.setViewport(MOBILE_BREAKPOINT, 800);
  expectPicker(app, "house", CHIP, false);
  // A phone turned on its side is still a phone, and back upright.
  await app.setViewport(390, 844);
  expectPicker(app, "house", CHIP, false);
  await app.setViewport(844, 390);
  expectPicker(app, "house", CHIP, false);
  // A choice made at phone width shows its name once the window widens.
  await pick(app, "house", "cheap");
  expectPicker(app, "cheap", LOGO, false);
  await app.setViewport(1280, 800);
  expectPicker(app, "cheap", LOGO, true);
});

test("on the Android phone the closed picker shows the mark alone and switches profiles", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/chat/topic-1", api: api({ body: null }) });
  await app.waitUntil(() => app.count("id:chat-composer-profile") === 1, { timeout: 10000 });
  expectPicker(app, "Default", LOGO, false);
  await pick(app, "Default", "house");
  expectPicker(app, "house", CHIP, false);
});

test("with no profile but the default route there is no picker, at any width", async () => {
  const routes = { ...api({ body: null }), "GET /proxy:/llm/profiles": { body: { default: { model: "gpt-5.2" }, items: [] } } };
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: routes });
  await app.waitFor("id:chat-composer-input");
  expect(app.count("id:chat-composer-profile")).toBe(0);
  await app.setViewport(390, 844);
  await app.waitFor("id:chat-composer-input");
  expect(app.count("id:chat-composer-profile")).toBe(0);
});
