// The device sign-in dialogs and flows (components/settings/AuthDialogs.tsx).
import { expect, test } from "nsh/test";
import { openFixture } from "./fixtures/integrations-harness";

const SIGNED_OUT = { status: { logged_in: false } };

test("Pro: opening while signed out starts a sign-in, polls until done, and reports the new settings", async () => {
  let polls = 0;
  const { app, calls, eventsNamed } = await openFixture({
    view: "auth",
    api: {
      "GET /auth/pro/status": { body: SIGNED_OUT },
      "POST /auth/pro/login/start": {
        body: {
          session_id: "s-1",
          verification_url_complete: "https://router.example/device?code=ABCD",
          user_code: "ABCD-1234",
          expires_at: "2030-01-01T00:00:00Z",
          interval_seconds: 1,
        },
      },
      "POST /auth/pro/login/poll": () => {
        polls += 1;
        return polls === 1
          ? { body: { pending: true, interval_seconds: 1 } }
          : { body: { status: { logged_in: true, user: { name: "Ada" } }, settings_updated: true } };
      },
    },
  });
  await app.press("Open Pro");
  await app.waitFor("id:pro-auth-dialog");
  await app.waitFor("ABCD-1234");
  expect(app.texts()).toContain("Finish authorization in the browser with this code.");
  expect(app.openedUrls()).toContain("https://router.example/device?code=ABCD");
  await app.waitUntil(() => eventsNamed("pro.settingsUpdated").length === 1, { timeout: 8000 });
  await app.waitFor("Account: Ada");
  await app.waitFor("Signed in");
  expect(app.shows("ABCD-1234")).toBe(false);
  const pollCalls = calls.filter((call) => call.path === "/auth/pro/login/poll");
  expect(pollCalls.length).toBe(2);
  expect(pollCalls[0].json).toEqual({ session_id: "s-1", set_default: true });
  expect(app.texts()).toContain("View Pro Usage");
  await app.press("View Pro Usage");
  expect(app.openedUrls()).toContain("https://router.mistermorph.com/console/usage");
});

test("Pro: a failing sign-in start shows the server's error and no code", async () => {
  const { app } = await openFixture({
    view: "auth",
    api: {
      "GET /auth/pro/status": { body: SIGNED_OUT },
      "POST /auth/pro/login/start": { status: 500, body: { error: "router unreachable" } },
    },
  });
  await app.press("Open Pro");
  await app.waitFor("id:device-auth-error");
  expect(app.texts()).toContain("router unreachable");
  expect(app.shows("id:device-auth-user-code")).toBe(false);
  expect(app.texts()).toContain("Signed out");
});

test("Pro: closing the dialog abandons the sign-in", async () => {
  const { app, calls } = await openFixture({
    view: "auth",
    api: {
      "GET /auth/pro/status": { body: SIGNED_OUT },
      "POST /auth/pro/login/start": { body: { session_id: "s-2", user_code: "WXYZ", interval_seconds: 2 } },
      "POST /auth/pro/login/poll": { body: { pending: true } },
    },
  });
  await app.press("Open Pro");
  await app.waitFor("WXYZ");
  await app.press("label:Close");
  await app.waitFor("id:pro-auth-dialog", { state: "gone" });
  await app.wait(2500);
  expect(calls.some((call) => call.path === "/auth/pro/login/poll")).toBe(false);
});

test("Pro: a sign-in stays on the endpoint it started on; switching endpoints abandons it", async () => {
  const { app, calls } = await openFixture({
    view: "auth",
    api: {
      "GET /auth/pro/status": { body: SIGNED_OUT },
      "POST /auth/pro/login/start": { body: { session_id: "s-3", user_code: "MOVE-1", interval_seconds: 1 } },
      "POST /auth/pro/login/poll": { body: { pending: true, interval_seconds: 1 } },
    },
  });
  await app.press("Open Pro");
  await app.waitFor("MOVE-1");
  await app.host.send("morph.fixture.endpoint", "ep_remote");
  await app.waitFor("MOVE-1", { state: "gone", timeout: 4000 });
  expect(calls.some((call) => call.path === "/auth/pro/login/poll")).toBe(false);
  expect(calls.some((call) => call.path === "/proxy")).toBe(false);
});

test("xAI: signed in, Sign in again starts a session with the default switch; logout shows the revocation warning", async () => {
  let pollBody: any = null;
  const { app } = await openFixture({
    view: "auth",
    api: {
      "GET /auth/xai/status": { body: { status: { logged_in: true } } },
      "POST /auth/xai/login/start": { body: { session_id: "x-1", user_code: "GROK-1", interval_seconds: 1 } },
      // Pending until a poll asks for the default: the switch's value reaches the server.
      "POST /auth/xai/login/poll": (request) => {
        if (request.json?.set_default !== true) return { body: { pending: true, interval_seconds: 1 } };
        pollBody = request.json;
        return { body: { status: { logged_in: true } } };
      },
      "POST /auth/xai/logout": { body: { status: { logged_in: false }, revocation_warning: "Token revocation failed" } },
    },
  });
  // The page knows the status before the dialog opens: signed in, so opening starts no sign-in.
  await app.press("Load xAI");
  await app.waitFor("text:xai:signed-in");
  await app.press("Open xAI");
  await app.waitFor("id:xai-auth-dialog");
  await app.waitFor("Sign in again");
  expect(app.shows("GROK-1")).toBe(false);
  await app.press("Sign in again");
  await app.waitFor("GROK-1");
  await app.press("id:device-auth-set-default");
  await app.waitFor("text:default:true");
  await app.waitUntil(() => pollBody !== null, { timeout: 8000 });
  expect(pollBody).toEqual({ session_id: "x-1", set_default: true });
  await app.waitFor("GROK-1", { state: "gone" });
  await app.press("Logout");
  await app.waitFor("Token revocation failed");
  await app.waitFor("Signed out");
});

test("xAI: a status that fails to load says so", async () => {
  const { app } = await openFixture({
    view: "auth",
    api: {
      "GET /auth/xai/status": { status: 500, body: { error: "status exploded" } },
      "POST /auth/xai/login/start": { status: 500, body: { error: "start exploded" } },
    },
  });
  await app.press("Open xAI");
  await app.waitFor("id:device-auth-error");
  await app.waitUntil(() => app.texts().some((text) => text.includes("exploded")));
});

test("Codex: shows the account, the file mode warning, the usage link and logs out", async () => {
  const { app, eventsNamed } = await openFixture({ view: "auth" });
  await app.press("Open Codex");
  await app.waitFor("id:codex-auth-dialog");
  expect(app.texts()).toContain("Account ID: acct-42");
  expect(app.texts()).toContain("auth.json is world-readable");
  expect(app.texts()).toContain("Codex OAuth is ready for LLM calls.");
  await app.press("View Codex Usage");
  expect(app.openedUrls()).toContain("https://chatgpt.com/codex/settings/usage");
  await app.press("Logout");
  expect(eventsNamed("codex.logout").length).toBe(1);
});
