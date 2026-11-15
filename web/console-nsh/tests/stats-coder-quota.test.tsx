// The Usage page's Coding agents button and dialog (components/observe/CoderQuotaButton.tsx): each
// local coding CLI's subscription quota, a bar per window with how much is used and when it resets.
// Opening it reads the installed coders' quotas, the bars scanning meanwhile. No button for agents
// without the CLIs, nor for agents built before the route.
import { expect, test } from "nsh/test";
import { normalizeCoderQuota, shownCoders, untilText, windowExpired, windowGroups, windowLabel, windowTone } from "../components/observe/coder-quota";
import { openConsole } from "./harness";

const USAGE = { "GET /proxy:/stats/llm/usage": { body: { summary: {}, api_hosts: [], models: [] } }, "GET /proxy:/stats/llm/daily": { body: { days: [], summary: {}, models: [] } } };
// 3 hours 10 minutes (and a little) from now: "resets in 3h10m".
const LATER = new Date(Date.now() + (190 * 60 + 20) * 1000).toISOString();

/** Waits, with plain timers, until `ok` holds (the app's steps would wait for it to be quiet). */
async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const CLAUDE = {
  backend: "claude",
  status: "allowed_warning",
  observed_at: "2026-11-13T09:00:00Z",
  source: "run",
  windows: [
    { kind: "five_hour", window_minutes: 300, used_percent: 92, resets_at: LATER, status: "allowed_warning" },
    { kind: "seven_day", window_minutes: 10080, used_percent: 30, resets_at: LATER, status: "allowed" },
  ],
};
const CODEX = {
  backend: "codex",
  plan: "pro",
  status: "allowed",
  observed_at: "2026-11-13T10:00:00Z",
  source: "read",
  windows: [{ kind: "primary", window_minutes: 10080, used_percent: 9, resets_at: LATER, status: "allowed" }],
};

// The Antigravity CLI's quota: its limits are per model group. Here the Gemini group has a 5-hour
// and a weekly window, and the other group's week is used up.
const AGY = {
  backend: "agy",
  status: "allowed_warning",
  observed_at: "2026-11-15T12:00:00Z",
  source: "read",
  groups: [
    { name: "Gemini Models", models: ["Gemini 3.8 Flash", "Gemini 3.8 Pro"] },
    { name: "Claude and GPT models", models: ["Claude Sonnet 4.6", "GPT-OSS 120B"] },
  ],
  windows: [
    { kind: "gemini-5h", group: "Gemini Models", window_minutes: 300, used_percent: 41, resets_at: LATER, status: "allowed" },
    { kind: "gemini-weekly", group: "Gemini Models", window_minutes: 10080, used_percent: 7, resets_at: LATER, status: "allowed" },
    { kind: "3p-weekly", group: "Claude and GPT models", window_minutes: 10080, used_percent: 100, resets_at: LATER, status: "rejected" },
  ],
};

test("windows are named by their length, and the bars warn near the limit", () => {
  expect(windowLabel({ kind: "five_hour", window_minutes: 300 })).toBe("5h");
  expect(windowLabel({ kind: "primary", window_minutes: 10080 })).toBe("7d");
  expect(windowLabel({ kind: "seven_day_opus", window_minutes: 10080 })).toBe("7d opus");
  expect(windowLabel({ kind: "seven_day_fable", window_minutes: 10080 })).toBe("7d fable");
  expect(windowLabel({ kind: "odd" })).toBe("odd");
  expect(windowTone({ kind: "a", used_percent: 50 })).toBe(undefined);
  expect(windowTone({ kind: "a", used_percent: 70 })).toBe("warn");
  expect(windowTone({ kind: "a", used_percent: 10, status: "allowed_warning" })).toBe("warn");
  expect(windowTone({ kind: "a", used_percent: 90 })).toBe("danger");
  expect(windowTone({ kind: "a", used_percent: 10, status: "rejected" })).toBe("danger");
  const now = new Date("2026-11-13T10:00:00Z");
  expect(untilText("2026-11-13T13:10:00Z", now)).toBe("3h10m");
  expect(untilText("2026-11-18T14:00:00Z", now)).toBe("5d 4h");
  expect(untilText("2026-11-13T10:12:00Z", now)).toBe("12m");
  expect(untilText("2026-11-13T09:00:00Z", now)).toBe("");
  expect(untilText("", now)).toBe("");
  expect(windowExpired({ kind: "a", resets_at: "2026-11-13T09:00:00Z" }, now)).toBe(true);
  expect(windowExpired({ kind: "a", resets_at: LATER }, now)).toBe(false);
});

test("the coders shown: installed here or with a quota, in a fixed order", () => {
  const payload = normalizeCoderQuota({ quotas: [CLAUDE, { backend: "" }, null], available: { codex: true, claude: false }, errors: { codex: "not logged in" } });
  const shown = shownCoders(payload);
  expect(shown.map((c) => c.backend)).toEqual(["codex", "claude"]);
  expect(shown[0].quota).toBe(null);
  expect(shown[0].error).toBe("not logged in");
  expect(shown[1].quota?.windows.length).toBe(2);
  expect(shownCoders(normalizeCoderQuota({ quotas: [], available: {} }))).toEqual([]);
  expect(shownCoders(normalizeCoderQuota(null))).toEqual([]);
});

test("opening the dialog reads the coders' quotas, the bars scanning meanwhile, then shows each window", async () => {
  let reads = 0;
  let answer: (() => void) | null = null;
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      "GET /proxy:/stats/coder/quota": { body: { quotas: [CLAUDE], available: { codex: true, claude: true } } },
      // Held until the test lets it answer: the read under way.
      "POST /proxy:/stats/coder/quota/refresh": () => {
        reads++;
        return new Promise((resolve) => {
          answer = () => resolve({ body: { quotas: [CLAUDE, CODEX], available: { codex: true, claude: true } } });
        });
      },
    },
  });
  // A button in the page's bar, no block on the page, and nothing read before it is pressed.
  await app.waitFor("id:stats-coders-open");
  expect(app.shows("id:stats-coder-claude")).toBe(false);
  expect(reads).toBe(0);

  // A step waits for the app to be quiet, and the held read keeps it busy: the press is awaited
  // once the read answers, and the screen meanwhile is watched with plain timers.
  const pressed = app.press("id:stats-coders-open");
  await until(() => reads === 1 && app.shows("id:stats-coder-codex-loading"));
  // While it reads: the saved Claude windows keep their last share over a scanning line, and
  // Codex, with nothing saved, scans in two windows' places; no Refresh button.
  expect(app.shows("id:stats-coder-claude-reading")).toBe(true);
  expect(app.shows("id:stats-coder-claude-five_hour")).toBe(true);
  expect(app.shows("label:Reading…")).toBe(true);
  expect(app.shows("id:stats-coders-refresh")).toBe(false);

  answer!();
  await pressed;
  await app.waitFor("id:stats-coder-codex-primary");
  await app.waitFor("id:stats-coder-claude-reading", { state: "gone" });
  expect(app.shows("id:stats-coder-codex-loading")).toBe(false);
  expect(app.shows("label:Reading…")).toBe(false);
  // Each window: its share, large, and when it starts again.
  expect(app.texts()).toContain("92%");
  expect(app.texts()).toContain("30%");
  expect(app.texts()).toContain("9%");
  expect(app.texts().some((text) => text.startsWith("Resets in 3h10m · "))).toBe(true);
  expect(app.texts()).toContain("PRO");
  // Near the limit: Claude Code said so.
  expect(app.shows("id:stats-coder-claude-status")).toBe(true);
  expect(app.shows("id:stats-coder-claude-observed")).toBe(true);
  expect(reads).toBe(1);
});

test("a failed read says why under the coder, and one with nothing reported says so", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      "GET /proxy:/stats/coder/quota": { body: { quotas: [], available: { codex: true, claude: true } } },
      "POST /proxy:/stats/coder/quota/refresh": {
        body: { quotas: [], available: { codex: true, claude: true }, errors: { codex: "codex app-server: not logged in" } },
      },
    },
  });
  await app.press("id:stats-coders-open");
  await app.waitFor("id:stats-coder-codex-error");
  expect(app.texts()).toContain("codex app-server: not logged in");
  expect(app.shows("id:stats-coder-claude-empty")).toBe(true);
  expect(app.texts()).toContain("Nothing reported yet.");
});

test("an agent with a saved quota and neither CLI here shows it without a read", async () => {
  let reads = 0;
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      "GET /proxy:/stats/coder/quota": { body: { quotas: [CODEX], available: {} } },
      "POST /proxy:/stats/coder/quota/refresh": () => {
        reads++;
        return { body: { quotas: [CODEX], available: {} } };
      },
    },
  });
  await app.press("id:stats-coders-open");
  await app.waitFor("id:stats-coder-codex-primary");
  await app.wait(100);
  expect(reads).toBe(0);
  expect(app.shows("id:stats-coder-codex-reading")).toBe(false);
});

test("no button where neither CLI is installed, nor for an agent without the route", async () => {
  for (const quota of [
    { body: { quotas: [], available: { codex: false, claude: false } } },
    { status: 404, body: { error: "not found" } },
  ]) {
    const { app } = await openConsole({ location: "/e/default/stats", api: { ...USAGE, "GET /proxy:/stats/coder/quota": quota } });
    await app.waitFor("NO USAGE RECORDS");
    await app.wait(100);
    expect(app.shows("id:stats-coders-open")).toBe(false);
    await app.dispose();
  }
});

test("a coder's windows by model group: one unnamed group without groups, one per group with them", () => {
  const payload = normalizeCoderQuota({ quotas: [CODEX, AGY, { backend: "claude", windows: [], groups: [null, { name: "" }, { name: "G", models: [1, "m"] }] }], available: { agy: true } });
  expect(shownCoders(payload).map((c) => c.backend)).toEqual(["codex", "claude", "agy"]);
  const [codex, agy, claude] = payload.quotas;
  expect(windowGroups(codex).map((g) => [g.name, g.models, g.windows.map((w) => w.kind)])).toEqual([["", [], ["primary"]]]);
  expect(windowGroups(agy).map((g) => [g.name, g.models, g.windows.map((w) => w.kind)])).toEqual([
    ["Gemini Models", ["Gemini 3.8 Flash", "Gemini 3.8 Pro"], ["gemini-5h", "gemini-weekly"]],
    ["Claude and GPT models", ["Claude Sonnet 4.6", "GPT-OSS 120B"], ["3p-weekly"]],
  ]);
  expect(claude.groups).toEqual([{ name: "G", models: ["m"] }]);
  expect(windowGroups(claude)).toEqual([]);
  expect(windowGroups(null)).toEqual([]);
  // A window whose group the quota does not list still shows, under its group's name.
  expect(windowGroups({ ...agy, groups: [] }).map((g) => [g.name, g.models])).toEqual([["Gemini Models", []], ["Claude and GPT models", []]]);
});

test("the Antigravity CLI is a third coder: a row per group and window under each group's name and models", async () => {
  let reads = 0;
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      // Only agy is installed here: the button shows for it, and opening reads its quota.
      "GET /proxy:/stats/coder/quota": { body: { quotas: [CODEX], available: { codex: false, claude: false, agy: true } } },
      "POST /proxy:/stats/coder/quota/refresh": () => {
        reads++;
        return { body: { quotas: [AGY, CODEX], available: { codex: false, claude: false, agy: true } } };
      },
    },
  });
  await app.press("id:stats-coders-open");
  await app.waitFor("id:stats-coder-agy-gemini-weekly");
  expect(reads).toBe(1);
  // Codex first, agy after it, under its own name.
  expect(app.shows("id:stats-coder-codex-primary")).toBe(true);
  expect(app.shows("id:stats-coder-claude")).toBe(false);
  expect(app.shows("id:stats-coder-agy >> text:Antigravity CLI")).toBe(true);
  // Each group: its name, its models, then its windows.
  expect(app.shows("id:stats-coder-agy-group-0 >> text:Gemini Models")).toBe(true);
  expect(app.shows("id:stats-coder-agy-group-0-models")).toBe(true);
  expect(app.texts()).toContain("Gemini 3.8 Flash, Gemini 3.8 Pro");
  expect(app.shows("id:stats-coder-agy-group-1 >> text:Claude and GPT models")).toBe(true);
  expect(app.shows("id:stats-coder-agy-group-1-models")).toBe(true);
  expect(app.texts()).toContain("Claude Sonnet 4.6, GPT-OSS 120B");
  expect(app.shows("id:stats-coder-agy-gemini-5h >> text:41%")).toBe(true);
  expect(app.shows("id:stats-coder-agy-gemini-weekly >> text:7%")).toBe(true);
  expect(app.shows("id:stats-coder-agy-3p-weekly >> text:100%")).toBe(true);
  // The bars say their group to a screen reader.
  const caption = app.texts().find((text) => text.startsWith("Resets in 3h10m · "));
  expect(app.shows(`label:Gemini Models 5h: 41%, ${caption}`)).toBe(true);
  expect(app.shows(`label:Claude and GPT models 7d: 100%, ${caption}`)).toBe(true);
  // One group at its limit: the coder is near a limit, not out of quota. Codex has no groups.
  expect(app.shows("id:stats-coder-agy-status >> text:Near limit")).toBe(true);
  expect(app.shows("id:stats-coder-codex-group-0")).toBe(false);
});

test("the Antigravity CLI not signed in: the read's reason shows under it", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      "GET /proxy:/stats/coder/quota": { body: { quotas: [], available: { agy: true } } },
      "POST /proxy:/stats/coder/quota/refresh": {
        body: { quotas: [], available: { agy: true }, errors: { agy: "agy is not signed in: run `agy` once in a terminal and sign in with a Google account, then try again" } },
      },
    },
  });
  await app.press("id:stats-coders-open");
  await app.waitFor("id:stats-coder-agy-error");
  expect(app.texts().some((text) => text.startsWith("agy is not signed in"))).toBe(true);
  expect(app.shows("id:stats-coder-agy-empty")).toBe(true);
});
