import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "weather",
    name: "Weather",
    version: "1.2.0",
    description: "Forecasts for any city",
    author: "Morph",
    license: "MIT",
    homepage: "https://example.com/weather",
    tags: ["web", "daily"],
    path: "skills/weather",
    commit: COMMIT,
    files: { "SKILL.md": {}, "run.sh": {} },
    total_bytes: 2048,
    ...overrides,
  };
}

const STORE = {
  repo: "morph/skills",
  skills: [
    entry(),
    entry({ id: "notes", name: "Notes", description: "Keeps notes", tags: ["daily"], installed: true, installed_version: "1.2.0" }),
    entry({ id: "mail", name: "Mail", description: "Reads mail", tags: ["web"], installed: true, installed_version: "1.0.0", update_available: true }),
  ],
};

const DOC_PATH = `GET /morph/skills/${COMMIT}/skills/weather/SKILL.md`;

test("the grid filters by search and tag; a card opens its details and SKILL.md from GitHub", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/skills/store",
    api: {
      "GET /settings/agent/skills/store": { body: STORE },
      [DOC_PATH]: { body: "---\nname: Weather\n---\n# Weather manual\n" },
    },
  });
  await app.waitFor("id:store-card:weather");
  expect(app.shows("id:store-card:notes")).toBe(true);
  expect(app.shows("text:Installed")).toBe(true);

  await app.press("id:store-tag:web");
  await app.waitFor("id:store-card:notes", { state: "gone" });
  expect(app.shows("id:store-card:mail")).toBe(true);
  await app.press("id:store-tag:web");
  await app.waitFor("id:store-card:notes");

  await app.type("id:store-search", "forecast");
  await app.waitFor("id:store-card:mail", { state: "gone" });
  await app.clear("id:store-search");
  await app.type("id:store-search", "nothing like it");
  await app.waitFor("text:No skills match.");
  await app.clear("id:store-search");

  await app.press("id:store-card:weather");
  await app.waitFor("id:store-detail");
  await app.waitFor("text:Weather manual");
  expect(app.shows("text:2 files · 2.00 KiB")).toBe(true);
  expect(app.shows(`text:morph/skills @ 0123456`)).toBe(true);
  expect(calls.some((call) => call.url.startsWith(`https://raw.githubusercontent.com/morph/skills/${COMMIT}/skills/weather/SKILL.md`))).toBe(true);

  await app.press("id:store-homepage");
  expect(app.openedUrls()).toContain("https://example.com/weather");

  await app.press("id:store-detail-close");
  await app.waitFor("id:store-detail", { state: "gone" });
});

test("Install starts a review task; a failed start shows the error in the panel", async () => {
  let task = "";
  let fail = true;
  const { app } = await openConsole({
    location: "/e/default/skills/store?skill=weather",
    api: {
      "GET /settings/agent/skills/store": { body: STORE },
      [DOC_PATH]: { status: 404, body: "missing" },
      "POST /proxy:/tasks": (request) => {
        if (fail) return { status: 500, body: { error: "agent busy" } };
        task = request.json.task;
        return { body: { topic_id: "topic-1" } };
      },
    },
  });
  await app.waitFor("id:store-install");
  await app.waitFor("id:store-doc-failed");
  await app.press("id:store-install");
  await app.waitFor("text:agent busy");
  fail = false;
  await app.press("id:store-install");
  await app.waitUntil(() => task !== "");
  expect(task).toContain("store_id: weather");
  expect(task.startsWith("Install")).toBe(true);
});

test("an installed skill opens on the Skills page; one with an update offers it", async () => {
  let task = "";
  const { app } = await openConsole({
    location: "/e/default/skills/store?skill=mail",
    api: {
      "GET /settings/agent/skills/store": { body: STORE },
      "GET /settings/agent/skills": { body: { enabled: true, load: [], skills: [] } },
      "POST /proxy:/tasks": (request) => {
        task = request.json.task;
        return { body: { topic_id: "t" } };
      },
    },
  });
  await app.waitFor("id:store-update");
  expect(app.shows("text:Update to v1.2.0")).toBe(true);
  expect(app.shows("text:1.2.0 · v1.0.0 installed")).toBe(true);
  await app.press("id:store-update");
  await app.waitUntil(() => task.startsWith("Update"));

  const other = await openConsole({
    location: "/e/default/skills/store?skill=notes",
    api: {
      "GET /settings/agent/skills/store": { body: STORE },
      "GET /settings/agent/skills": { body: { enabled: true, load: [], skills: [] } },
    },
  });
  await other.app.waitFor("id:store-open-installed");
  await other.app.press("id:store-open-installed");
  await other.app.waitFor("id:skills-page");
});

test("an unreachable store offers a retry; an agent without the store says so; an empty store says so", async () => {
  let attempts = 0;
  const broken = await openConsole({
    location: "/e/default/skills/store",
    api: {
      "GET /settings/agent/skills/store": () => {
        attempts += 1;
        return attempts === 1 ? { status: 502, body: { error: "bad gateway" } } : { body: STORE };
      },
    },
  });
  await broken.app.waitFor("text:The store could not be reached.");
  await broken.app.press("id:store-retry");
  await broken.app.waitFor("id:store-card:weather");

  const old = await openConsole({
    location: "/e/default/skills/store",
    api: { "GET /settings/agent/skills/store": { status: 404, body: { error: "not found" } } },
  });
  await old.app.waitFor("text:This agent does not support the store yet. Update it to install from here.");

  const empty = await openConsole({
    location: "/e/default/skills/store",
    api: { "GET /settings/agent/skills/store": { body: { repo: "morph/skills", skills: [] } } },
  });
  await empty.app.waitFor("text:No skills in the store yet.");
});

test("the back button goes to Skills", async () => {
  const { app } = await openConsole({
    location: "/e/default/skills/store",
    api: {
      "GET /settings/agent/skills/store": { body: STORE },
      "GET /settings/agent/skills": { body: { enabled: true, load: [], skills: [] } },
    },
  });
  await app.waitFor("id:store-back");
  await app.press("id:store-back");
  await app.waitFor("id:skills-page");
});

test("on a phone the details slide in over the grid and close again", async () => {
  const { app } = await openConsole({
    location: "/e/default/skills/store",
    width: 420,
    api: {
      "GET /settings/agent/skills/store": { body: STORE },
      [DOC_PATH]: { body: "# Weather manual\n" },
    },
  });
  await app.waitFor("id:store-card:weather");
  await app.press("id:store-card:weather");
  await app.waitFor("id:store-detail");
  await app.waitFor("text:Weather manual");
  await app.press("id:store-detail-close");
  await app.waitFor("id:store-detail", { state: "gone" });
});
