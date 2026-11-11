import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const SKILL_MD = "---\nname: Weather\ndescription: Forecasts\n---\n# Weather skill\n\nAsk for the weather.\n";

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "weather",
    name: "Weather",
    description: "Forecasts",
    dir: "/home/me/.morph/skills/weather",
    loaded: true,
    requirements: ["curl"],
    files: [
      { path: "SKILL.md", size: 120 },
      { path: "scripts/run.sh", size: 30 },
    ],
    ...overrides,
  };
}

function catalog(skills: unknown[], overrides: Record<string, unknown> = {}) {
  return { enabled: true, load: [], roots: ["/home/me/.morph/skills"], config_revision: "rev-1", skills, ...overrides };
}

const BASE = {
  "GET /settings/agent/skills/store": { status: 404, body: { error: "not found" } },
  "GET /settings/agent/skills/detail": { body: { content: SKILL_MD, revision: "doc-1" } },
};

test("the list opens its first skill, with its facts and SKILL.md without frontmatter", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/skills",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill(), skill({ id: "notes", name: "Notes", description: "Keeps notes", loaded: false })]) },
    },
  });
  await app.waitFor("id:skill-detail");
  await app.waitFor("text:Weather skill");
  expect(app.shows("text:name: Weather")).toBe(false);
  expect(app.texts()).toContain("/home/me/.morph/skills/weather");
  expect(app.shows("text:curl")).toBe(true);
  expect(app.shows("text:Loaded into every task.")).toBe(true);
  expect(calls.some((call) => call.path === "/settings/agent/skills/detail" && call.query.get("id") === "weather")).toBe(true);

  await app.press("id:skill-row:notes");
  await app.waitFor("text:Loaded only when a task names it as $Notes.");
});

test("a switch saves the load list and reads the catalog again; a failed save shows why", async () => {
  let saved: any = null;
  let fail = false;
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": () => ({
        body: catalog(
          [skill({ loaded: !saved || saved.skills.load.includes("weather") }), skill({ id: "notes", name: "Notes" })],
          saved ? { load: saved.skills.load } : {},
        ),
      }),
      "PUT /settings/agent": (request) => {
        if (fail) return { status: 500, body: { error: "disk full" } };
        saved = request.json;
        return { body: {} };
      },
    },
  });
  await app.waitFor("text:Loaded into every task.");
  await app.press("id:skill-loaded");
  await app.waitUntil(() => saved !== null);
  expect(saved).toEqual({ config_revision: "rev-1", skills: { enabled: true, load: ["notes"] } });
  await app.waitFor("text:Loaded only when a task names it as $Weather.");

  // As on the Vue page, a failed save reads the catalog again, which shows the stored value (and
  // clears the error once that read succeeds).
  fail = true;
  const before = saved;
  await app.press("id:skill-loaded");
  await app.wait(200);
  expect(saved).toBe(before);
  await app.waitFor("text:Loaded only when a task names it as $Weather.");
});

test("an agent without skills routes says so; an empty list says where skills go; a 500 is shown", async () => {
  const unsupported = await openConsole({
    location: "/e/default/skills",
    api: { ...BASE, "GET /settings/agent/skills": { status: 404, body: { error: "not found" } } },
  });
  await unsupported.app.waitFor("text:This agent does not report its skills yet. Update it to manage skills here.");
  expect(unsupported.app.enabled("id:skills-add")).toBe(false);

  const empty = await openConsole({
    location: "/e/default/skills",
    api: { ...BASE, "GET /settings/agent/skills": { body: catalog([]) } },
  });
  await empty.app.waitFor("text:Add one from a link, or put a folder with a SKILL.md under /home/me/.morph/skills.");
  await empty.app.waitFor("text:No skills yet");

  const broken = await openConsole({
    location: "/e/default/skills",
    api: { ...BASE, "GET /settings/agent/skills": { status: 500, body: { error: "agent exploded" } } },
  });
  await broken.app.waitFor("text:agent exploded");
});

test("the file tree opens folders and shows a file as plain text, then goes back to SKILL.md", async () => {
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill()]) },
      "GET /settings/agent/skills/dir": (request) =>
        request.query.get("path") === "scripts"
          ? { body: { path: "scripts", entries: [{ name: "run.sh", kind: "file", size: 30 }, { name: "big.bin", kind: "file", size: 999999 }] } }
          : {
              body: {
                path: "",
                entries: [
                  { name: "SKILL.md", kind: "file", size: 120 },
                  { name: "scripts", kind: "dir" },
                  { name: "link", kind: "symlink" },
                ],
              },
            },
      "GET /settings/agent/skills/file": (request) =>
        request.query.get("path") === "scripts/run.sh"
          ? { body: { path: "scripts/run.sh", kind: "text", size: 30, content: "<b>echo hi</b>" } }
          : { body: { path: "scripts/big.bin", kind: "too_large", size: 999999, limit: 262144 } },
    },
  });
  await app.waitFor("text:2 files · 150 B");
  await app.press("id:skill-files-toggle");
  await app.waitFor("id:skill-file:scripts");
  expect(app.shows("text:link, not followed")).toBe(true);
  await app.press("id:skill-file:scripts");
  await app.waitFor("id:skill-file:scripts/run.sh");
  await app.press("id:skill-file:scripts/run.sh");
  // The markup is shown as it is, not rendered.
  await app.waitFor("text:<b>echo hi</b>");
  expect(app.shows("text:Weather skill")).toBe(false);

  await app.press("id:skill-file:scripts/big.bin");
  await app.waitFor("text:This file is 977 KiB; files over 256 KiB are not shown here.");

  await app.press("id:skill-file-back");
  await app.waitFor("text:Weather skill");
});

test("an agent that cannot browse folders shows the catalog's flat list", async () => {
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill()]) },
      "GET /settings/agent/skills/dir": { status: 404, body: { error: "not found" } },
    },
  });
  await app.waitFor("id:skill-files-toggle");
  await app.press("id:skill-files-toggle");
  await app.waitFor("text:This agent cannot browse skill files yet. Update it to open them here.");
  expect(app.shows("text:scripts/run.sh")).toBe(true);
});

test("SKILL.md is edited and saved with its revision; a refused save keeps the editor and says why", async () => {
  let body: any = null;
  let refuse = true;
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill()]) },
      "POST /settings/agent/skills/update": (request) => {
        body = request.json;
        if (refuse) return { status: 409, body: { error: "SKILL.md changed on the agent" } };
        return { body: { content: request.json.content, revision: "doc-2" } };
      },
    },
  });
  await app.waitFor("id:skill-edit");
  await app.press("id:skill-edit");
  await app.waitFor("id:skill-editor");
  expect(app.enabled("id:skill-edit-save")).toBe(false);
  await app.type("id:skill-editor", "More.");
  await app.press("id:skill-edit-save");
  await app.waitFor("text:SKILL.md changed on the agent");
  expect(body.id).toBe("weather");
  expect(body.revision).toBe("doc-1");
  // The whole SKILL.md goes back, frontmatter included, with the typed text (where the caret was).
  expect(body.content.replace("More.", "")).toBe(SKILL_MD);

  refuse = false;
  await app.press("id:skill-edit-save");
  await app.waitFor("id:skill-edit");
  expect(app.shows("id:skill-editor")).toBe(false);
  await app.waitUntil(() => app.texts().some((text) => text.includes("More.")));
});

test("a skill is removed through its menu and a confirmation", async () => {
  let removed = "";
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": () => ({ body: catalog(removed ? [] : [skill({ source: { kind: "github", url: "https://github.com/a/b", repo: "a/b", commit: "0123456789abcdef" } })]) }),
      "POST /settings/agent/skills/remove": (request) => {
        removed = request.json.id;
        return { body: {} };
      },
    },
  });
  await app.waitFor("text:a/b @ 0123456");
  await app.press("id:skill-actions");
  await app.press("role:menuitem[Remove]");
  await app.waitFor("text:Remove Weather?");
  await app.press("id:dialog-action-remove");
  await app.waitUntil(() => removed === "weather");
  await app.waitFor("text:No skills yet");
});

test("Add skill checks the link, then starts a review task and opens its chat", async () => {
  let task = "";
  const { app } = await openConsole({
    location: "/e/default/skills",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill()]) },
      "POST /proxy:/tasks": (request) => {
        task = request.json.task;
        return { body: { topic_id: "topic-9", task_id: "task-1" } };
      },
      "GET /proxy:/topics/topic-9": { body: {} },
    },
  });
  await app.waitFor("id:skills-add");
  await app.press("id:skills-add");
  await app.waitFor("id:skills-add-link");
  await app.type("id:skills-add-link", "http://example.com/x");
  expect(app.enabled("id:skills-add-start")).toBe(false);
  await app.submit("id:skills-add-link");
  await app.waitFor("text:Enter an https link.");
  await app.clear("id:skills-add-link");
  await app.type("id:skills-add-link", "https://github.com/a/b/tree/main/skills/x");
  await app.press("id:skills-add-start");
  await app.waitUntil(() => task !== "");
  expect(task).toContain("https://github.com/a/b/tree/main/skills/x");
  await app.waitFor("id:skills-add-dialog", { state: "gone" });
});

test("a failed task start keeps the dialog open with the error", async () => {
  const { app } = await openConsole({
    location: "/e/default/skills",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill()]) },
      "POST /proxy:/tasks": { status: 500, body: { error: "agent busy" } },
    },
  });
  await app.waitFor("id:skills-add");
  await app.press("id:skills-add");
  await app.type("id:skills-add-link", "https://github.com/a/b");
  await app.press("id:skills-add-start");
  await app.waitFor("text:agent busy");
  expect(app.shows("id:skills-add-dialog")).toBe(true);
});

test("search appears for long lists and filters by name and description", async () => {
  const many = Array.from({ length: 10 }, (_, index) => skill({ id: `s${index}`, name: `Skill ${index}`, description: index === 7 ? "Finds planets" : "Other" }));
  const { app } = await openConsole({
    location: "/e/default/skills",
    api: { ...BASE, "GET /settings/agent/skills": { body: catalog(many) } },
  });
  await app.waitFor("id:skills-search");
  await app.type("id:skills-search", "planets");
  await app.waitFor("id:skill-row:s3", { state: "gone" });
  expect(app.shows("id:skill-row:s7")).toBe(true);
  await app.type("id:skills-search", "zzz");
  await app.waitFor("text:No skills match.");
});

test("an installed store skill with a newer version offers the update", async () => {
  let task = "";
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": { body: catalog([skill({ source: { kind: "store", store_id: "weather", version: "1.0.0" } })]) },
      "GET /settings/agent/skills/store": { body: { repo: "morph/skills", skills: [{ id: "weather", name: "Weather", version: "1.2.0", installed: true, update_available: true }] } },
      "POST /proxy:/tasks": (request) => {
        task = request.json.task;
        return { body: { topic_id: "t-2" } };
      },
    },
  });
  await app.waitFor("text:Version 1.2.0 is in the store.");
  await app.press("id:skill-update");
  await app.waitUntil(() => task.includes("store_id: weather"));
});

test("the ⋯ menu above the list turns all skills off", async () => {
  let saved: any = null;
  const { app } = await openConsole({
    location: "/e/default/skills?skill=weather",
    api: {
      ...BASE,
      "GET /settings/agent/skills": () => ({ body: catalog([skill()], saved ? { enabled: saved.skills.enabled } : {}) }),
      "PUT /settings/agent": (request) => {
        saved = request.json;
        return { body: {} };
      },
    },
  });
  await app.waitFor("text:Loaded into every task.");
  await app.press("id:skills-more");
  await app.waitFor("id:skills-enabled");
  await app.press("id:skills-enabled");
  await app.waitUntil(() => saved !== null);
  expect(saved.skills).toEqual({ enabled: false, load: [] });
  await app.waitFor("text:All skills are off. Turn them on from the ⋯ menu above the list.");
});

test("on a phone the list and a skill take turns, with a back button", async () => {
  const { app } = await openConsole({
    location: "/e/default/skills",
    width: 420,
    api: { ...BASE, "GET /settings/agent/skills": { body: catalog([skill()]) } },
  });
  await app.waitFor("id:skill-row:weather");
  expect(app.shows("id:skill-detail")).toBe(false);
  expect(app.shows("id:skills-fab")).toBe(true);
  await app.press("id:skill-row:weather");
  await app.waitFor("id:skill-detail");
  // The skill slides in over the list, which goes once the slide has ended.
  await app.waitFor("id:skill-row:weather", { state: "gone" });
  await app.press("label:Back");
  await app.waitFor("id:skill-row:weather");
});
