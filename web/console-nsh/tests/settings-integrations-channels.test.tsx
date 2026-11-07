// WeChat QR login and X OAuth login (components/settings/ChannelLoginPanels.tsx).
import { expect, test } from "nsh/test";
import { openFixture } from "./fixtures/integrations-harness";

test("WeChat: connect shows the QR code, asks for the phone's code, and reports the connection", async () => {
  let polls = 0;
  const { app, calls, eventsNamed } = await openFixture({
    view: "channels",
    api: {
      "POST /settings/wechat/login/start": { body: { session_id: "w-1", qr_url: "https://weixin.example/qr/abc" } },
      "POST /settings/wechat/login/poll": (request) => {
        polls += 1;
        if (polls === 1) return { delay: 50, body: { status: "scaned", done: false } };
        if (polls === 2) return { delay: 50, body: { status: "need_verifycode", done: false } };
        return request.json?.verify_code === "123456"
          ? { body: { status: "confirmed", done: true, connected: true, bot_id: "bot-9", user_id: "user-1" } }
          : { body: { status: "verify_code_blocked", done: true, connected: false } };
      },
    },
  });
  await app.press("Connect WeChat");
  await app.waitFor("id:wechat-login-qr");
  await app.waitFor("Enter the verification code shown on your phone.");
  expect(app.enabled("Submit")).toBe(false);
  await app.type("id:wechat-login-code", "123456");
  await app.press("Submit");
  await app.waitFor("Connected bot-9 for user-1.");
  expect(eventsNamed("wechat.changed").length).toBe(1);
  const pollCalls = calls.filter((call) => call.path === "/settings/wechat/login/poll");
  expect(pollCalls.at(-1)?.json).toEqual({ session_id: "w-1", verify_code: "123456" });
  // The page reloaded: the bot is bound now.
  await app.waitFor("Connected bot");
  expect(app.texts()).toContain("bot-7");
});

test("WeChat: the QR link opens, Cancel stops the login, and a failed start says why", async () => {
  let starts = 0;
  const { app } = await openFixture({
    view: "channels",
    api: {
      "POST /settings/wechat/login/start": () => {
        starts += 1;
        return starts === 1
          ? { body: { session_id: "w-2", qr_url: "https://weixin.example/qr/xyz" } }
          : { status: 502, body: { error: "wechat is down" } };
      },
      "POST /settings/wechat/login/poll": { delay: 4000, body: { status: "wait", done: false } },
    },
  });
  await app.press("Connect WeChat");
  await app.waitFor("Scan the QR code with WeChat.");
  await app.press("Open the QR link");
  expect(app.openedUrls()).toContain("https://weixin.example/qr/xyz");
  await app.press("Cancel");
  await app.waitFor("id:wechat-login-qr", { state: "gone" });
  await app.press("Connect WeChat");
  await app.waitFor("wechat is down");
  expect(app.shows("id:wechat-login-qr")).toBe(false);
});

test("WeChat: an expired QR code ends the login with its message", async () => {
  const { app } = await openFixture({
    view: "channels",
    api: {
      "POST /settings/wechat/login/start": { body: { session_id: "w-3", qr_url: "https://weixin.example/qr/old" } },
      "POST /settings/wechat/login/poll": { body: { status: "expired", done: true, connected: false } },
    },
  });
  await app.press("Connect WeChat");
  await app.waitFor("id:channel-login-error");
  expect(app.texts()).toContain("The QR code expired. Start again for a new one.");
  expect(app.shows("id:wechat-login-qr")).toBe(false);
});

test("WeChat: disconnecting a bound bot takes a second press", async () => {
  const { app, calls, eventsNamed } = await openFixture({
    view: "channels",
    params: { configured: true },
    api: { "POST /settings/wechat/logout": { body: {} } },
  });
  await app.waitFor("bot-7");
  await app.press("Disconnect");
  await app.waitFor("Click again to disconnect");
  expect(calls.some((call) => call.path === "/settings/wechat/logout")).toBe(false);
  await app.press("Click again to disconnect");
  await app.waitUntil(() => eventsNamed("wechat.changed").length === 1);
  expect(calls.filter((call) => call.path === "/settings/wechat/logout").length).toBe(1);
});

test("WeChat: a failed disconnect shows the error", async () => {
  const { app } = await openFixture({
    view: "channels",
    params: { configured: true },
    api: { "POST /settings/wechat/logout": { status: 500, body: { error: "logout failed upstream" } } },
  });
  await app.press("Disconnect");
  await app.press("Click again to disconnect");
  await app.waitFor("logout failed upstream");
});

test("X: needs the client ID first", async () => {
  const { app } = await openFixture({ view: "channels", params: { ready: false } });
  await app.waitFor("Save the Client ID first.");
  expect(app.enabled("Log in to X")).toBe(false);
});

test("X: login opens X, waits for the redirect, and reports the account", async () => {
  let polls = 0;
  const { app, eventsNamed } = await openFixture({
    view: "channels",
    api: {
      "POST /settings/x/login/start": { body: { session_id: "x-1", authorize_url: "https://x.example/oauth?state=1" } },
      "POST /settings/x/login/poll": () => {
        polls += 1;
        return polls === 1 ? { delay: 50, body: { done: false } } : { delay: 50, body: { done: true, connected: true, username: "morph" } };
      },
    },
  });
  await app.press("Log in to X");
  await app.waitFor("Approve in the X tab that opened. This waits until X sends you back.");
  expect(app.openedUrls()).toContain("https://x.example/oauth?state=1");
  await app.waitFor("Logged in as @morph.");
  expect(eventsNamed("x.changed").length).toBe(1);
  await app.waitFor("@morph");
});

test("X: a refused authorization shows X's error; logout takes a second press", async () => {
  const { app, calls } = await openFixture({
    view: "channels",
    params: { loggedIn: true },
    api: {
      "POST /settings/x/login/start": { body: { session_id: "x-2", authorize_url: "https://x.example/oauth?state=2" } },
      "POST /settings/x/login/poll": { body: { done: true, connected: false, error: "access_denied" } },
      "POST /settings/x/logout": { body: {} },
    },
  });
  await app.press("Log in again");
  await app.waitFor("access_denied");
  await app.press("Log out");
  await app.waitFor("Click again to log out");
  await app.press("Click again to log out");
  await app.waitUntil(() => calls.some((call) => call.path === "/settings/x/logout"));
});
