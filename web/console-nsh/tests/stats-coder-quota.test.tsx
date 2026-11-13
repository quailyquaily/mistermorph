// The Usage page's Coding agents block (components/observe/CoderQuotaPanel.tsx): each local coding
// CLI's subscription quota, a bar per window with how much is used and when it resets; Refresh
// reads Codex's again. Hidden for agents without the CLIs, and for agents built before the route.
import { expect, test } from "nsh/test";
import { normalizeCoderQuota, shownCoders, untilText, windowExpired, windowLabel, windowTone } from "../components/observe/coder-quota";
import { openConsole } from "./harness";

const USAGE = { "GET /proxy:/stats/llm/usage": { body: { summary: {}, api_hosts: [], models: [] } }, "GET /proxy:/stats/llm/daily": { body: { days: [], summary: {}, models: [] } } };
// 3 hours 10 minutes (and a little) from now: "resets in 3h10m".
const LATER = new Date(Date.now() + (190 * 60 + 20) * 1000).toISOString();

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

test("windows are named by their length, and the bars warn near the limit", () => {
  expect(windowLabel({ kind: "five_hour", window_minutes: 300 })).toBe("5h");
  expect(windowLabel({ kind: "primary", window_minutes: 10080 })).toBe("7d");
  expect(windowLabel({ kind: "seven_day_opus", window_minutes: 10080 })).toBe("7d opus");
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

test("the block shows each coder's windows, and Refresh reads Codex's quota", async () => {
  let refreshed = false;
  const { app, calls } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      "GET /proxy:/stats/coder/quota": { body: { quotas: [CLAUDE], available: { codex: true, claude: true } } },
      "POST /proxy:/stats/coder/quota/refresh": () => {
        refreshed = true;
        return { body: { quotas: [CLAUDE, CODEX], available: { codex: true, claude: true } } };
      },
    },
  });
  await app.waitFor("id:stats-coders");
  await app.waitFor("id:stats-coder-claude-five_hour");
  expect(app.texts()).toContain("92% used · resets in 3h10m");
  expect(app.texts()).toContain("30% used · resets in 3h10m");
  // Near the limit: Claude Code said so.
  expect(app.shows("id:stats-coder-claude-status")).toBe(true);
  // Codex is installed but has not reported yet.
  expect(app.shows("id:stats-coder-codex-empty")).toBe(true);

  await app.press("id:stats-coders-refresh");
  await app.waitUntil(() => refreshed);
  await app.waitFor("id:stats-coder-codex-primary");
  expect(app.texts()).toContain("9% used · resets in 3h10m");
  expect(app.texts()).toContain("PRO");
  expect(app.shows("id:stats-coder-codex-empty")).toBe(false);
  expect(calls.some((call) => call.method === "POST" && call.uri === "/stats/coder/quota/refresh")).toBe(true);
});

test("a failed refresh says why under the coder", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      ...USAGE,
      "GET /proxy:/stats/coder/quota": { body: { quotas: [], available: { codex: true } } },
      "POST /proxy:/stats/coder/quota/refresh": { body: { quotas: [], available: { codex: true }, errors: { codex: "codex app-server: not logged in" } } },
    },
  });
  await app.waitFor("id:stats-coders-refresh");
  // Without the Claude CLI and with no Claude quota, Claude Code is not listed.
  expect(app.shows("id:stats-coder-claude")).toBe(false);
  await app.press("id:stats-coders-refresh");
  await app.waitFor("id:stats-coder-codex-error");
  expect(app.texts()).toContain("codex app-server: not logged in");
});

test("no block where neither CLI is installed, nor for an agent without the route", async () => {
  for (const quota of [
    { body: { quotas: [], available: { codex: false, claude: false } } },
    { status: 404, body: { error: "not found" } },
  ]) {
    const { app } = await openConsole({ location: "/e/default/stats", api: { ...USAGE, "GET /proxy:/stats/coder/quota": quota } });
    await app.waitFor("NO USAGE RECORDS");
    await app.wait(100);
    expect(app.shows("id:stats-coders")).toBe(false);
    await app.dispose();
  }
});
