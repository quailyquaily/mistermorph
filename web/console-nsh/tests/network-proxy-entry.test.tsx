// The desktop app's network proxy on the pages before the console is entered
// (components/settings/NetworkProxySetting.tsx's NetworkProxyEntry): under the login card on the
// edge opposite the language menu, and at the top right of the setup card on every step. It opens
// the dialog Settings opens (tests/network-proxy.test.tsx covers that dialog), asks the host and
// never the console, and is there only where the host has the `networkProxy` feature.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { localEndpoint, loginProbe, openConsole } from "./harness";

type Options = Parameters<typeof openConsole>[0];

/** A host with the setting, as the desktop shell answers (desktop/nsh/src/proxy.rs). */
function fakeShell(options: { failGets?: number } = {}) {
  let saved: Record<string, unknown> = { mode: "system", type: "http", host: "", port: null, username: "", hasPassword: false };
  const running = { mode: "system" };
  const sets: any[] = [];
  const counts = { get: 0, quit: 0 };
  let failGets = options.failGets ?? 0;
  const view = () => ({ saved, running, pending: saved.mode === "explicit", credentialStore: true });
  const handlers = {
    "morph.desktop.networkProxy.get": () => {
      counts.get += 1;
      if (failGets > 0) {
        failGets -= 1;
        throw new Error("the host is not ready");
      }
      return view();
    },
    "morph.desktop.networkProxy.set": (data: any) => {
      sets.push(data);
      if (data.mode === "system") saved = { ...saved, mode: "system" };
      else saved = { mode: "explicit", type: data.type, host: data.host, port: Number(data.port), username: data.username, hasPassword: Boolean(data.password) };
      return { ok: true, ...view() };
    },
    "morph.desktop.quit": () => {
      counts.quit += 1;
      return null;
    },
  };
  return { handlers, sets, counts, saved: () => saved };
}

const DESKTOP = (shell: ReturnType<typeof fakeShell>): Options => ({
  runtime: "desktop",
  features: ["networkProxy", "quit"],
  host: shell.handlers,
});

/** The hosts without the setting. */
const WITHOUT: [string, Options][] = [
  ["browser", {}],
  ["desktop without the feature", { runtime: "desktop", features: ["quit"] }],
  ["Android", { platform: "android" }],
];

async function saveHTTPProxy(app: App) {
  await app.waitFor("id:network-proxy-dialog");
  await app.press("label:Proxy");
  await app.press("text:HTTP");
  await app.waitUntil(() => app.enabled("id:network-proxy-host"));
  await app.type("id:network-proxy-host", "proxy.example");
  await app.type("id:network-proxy-port", "8080");
  await app.press("id:network-proxy-dialog-save");
  // The same words as in Settings: it applies after quitting and reopening.
  await app.waitFor("id:network-proxy-apply");
  expect(app.shows("text:Quit and reopen to apply")).toBe(true);
}

/* ---------- the login page ---------- */

const LOGIN = "/e/default/todo";

for (const item of [
  { name: "a desktop window", width: 1280, height: 800 },
  { name: "a narrow window", width: 320, height: 640 },
]) {
  test(`login, ${item.name}: the proxy entry is on the card's left edge, in the language menu's row`, async () => {
    const shell = fakeShell();
    const { app } = await openConsole({ location: LOGIN, password: true, loginProbe: true, width: item.width, height: item.height, ...DESKTOP(shell) });
    const probe = loginProbe(app);
    await app.waitFor("id:login-password");
    await app.waitFor("id:network-proxy-entry");
    expect(app.shows("role:button[Network proxy]")).toBe(true);
    expect(app.shows("text:English")).toBe(true);
    const frames = await probe.frames(["column", "proxy", "language"]);
    const { column, proxy, language } = frames;
    // The row reaches 6pt past the card on both sides (each word's hover pill): the entry starts
    // where the row does, the language menu ends where it does.
    const row = column.w + 12;
    expect({ left: Math.round(proxy.x), right: Math.round(row - (language.x + language.w)) }).toEqual({ left: 0, right: 0 });
    // One row, the two centred on one line, not touching.
    expect(Math.abs(proxy.y + proxy.h / 2 - (language.y + language.h / 2)) <= 0.5).toBe(true);
    expect(proxy.x + proxy.w < language.x).toBe(true);
  });
}

test("login: the entry opens the proxy dialog and saves through the host, before any session", async () => {
  const shell = fakeShell();
  const { app, calls } = await openConsole({ location: LOGIN, password: true, ...DESKTOP(shell) });
  await app.waitFor("id:login-password");
  await app.waitUntil(() => shell.counts.get === 1);
  expect(app.shows("id:network-proxy-entry-pending")).toBe(false);
  const before = calls.length;
  await app.press("id:network-proxy-entry");
  await saveHTTPProxy(app);
  expect(shell.sets).toEqual([{ mode: "explicit", type: "http", host: "proxy.example", port: "8080", username: "" }]);
  // Saving stores the setting and nothing else: no quit, and nothing asked of the console.
  expect(shell.counts.quit).toBe(0);
  expect(calls.slice(before)).toEqual([]);
  await app.press("id:dialog-action-later");
  await app.waitUntil(() => !app.shows("id:network-proxy-apply"));
  // Still the login page, the entry now marked: a saved change waits for the app to be reopened.
  expect(app.shows("id:login-password")).toBe(true);
  await app.waitFor("id:network-proxy-entry-pending");
  expect(app.shows("role:button[Network proxy: Quit and reopen to apply]")).toBe(true);

  // Quit now asks first, as in Settings.
  await app.press("id:network-proxy-entry");
  await app.waitFor("id:network-proxy-dialog");
  expect(app.value("id:network-proxy-host")).toBe("proxy.example");
  await app.press("id:network-proxy-dialog-save");
  await app.waitFor("id:network-proxy-apply");
  await app.press("id:dialog-action-quit");
  await app.waitFor("text:Quit the app now?");
  await app.press("id:dialog-action-confirm");
  await app.waitUntil(() => shell.counts.quit === 1);
});

test("login: a setting that did not load is asked for again on press; a host that still fails is said", async () => {
  const shell = fakeShell({ failGets: 1 });
  const { app } = await openConsole({ location: LOGIN, password: true, ...DESKTOP(shell) });
  await app.waitFor("id:network-proxy-entry");
  await app.waitUntil(() => shell.counts.get === 1);
  await app.press("id:network-proxy-entry");
  await app.waitFor("id:network-proxy-dialog");
  expect(shell.counts.get).toBe(2);

  const broken = fakeShell({ failGets: 99 });
  const second = await openConsole({ location: LOGIN, password: true, ...DESKTOP(broken) });
  await second.app.waitFor("id:network-proxy-entry");
  await second.app.waitUntil(() => broken.counts.get === 1);
  await second.app.press("id:network-proxy-entry");
  await second.app.waitUntil(() => second.app.texts().some((text) => text.includes("the host is not ready")));
  expect(second.app.shows("id:network-proxy-dialog")).toBe(false);
});

test("login: no proxy entry in a browser, on a desktop host without the feature, or in the phone app", async () => {
  for (const [name, options] of WITHOUT) {
    const { app } = await openConsole({ location: LOGIN, password: true, ...options });
    await app.waitFor("id:login-password");
    expect([name, app.shows("id:network-proxy-entry")]).toEqual([name, false]);
    // The language menu stays where it was.
    expect([name, app.shows("text:English")]).toEqual([name, true]);
  }
});

/* ---------- the setup page ---------- */

/** A console at a setup step: without a model (the model step) or with one and no persona. */
function setupApi(configured: boolean, persona = false) {
  const identity = { name: persona ? "Nova" : "", creature: "", vibe: "", emoji: "", name_alts: [], soul: persona ? "# Soul" : "", extra: {} };
  return {
    "GET /endpoints": () => ({ body: { items: [localEndpoint({ can_submit: configured })] } }),
    "GET /settings/agent": {
      body: configured
        ? { config_source: "config", config_revision: "rev-2", llm: { provider: "openai", model: "gpt-test" }, tools: {} }
        : { config_source: "defaults", config_revision: "rev-1", llm: {}, tools: {} },
    },
    "GET /proxy:/state/files": {
      body: {
        items: [...(persona ? ["identity.yaml", "soul.md"] : []), "HEARTBEAT.md", "cron.yaml"].map((name) => ({
          name,
          exists: true,
          path: `/state/${name}`,
          group: "persona",
        })),
      },
    },
    "GET /proxy:/persona/identity": { body: { exists: persona, identity } },
    "GET /proxy:/persona/avatar": { status: 404, body: { error: "not found" } },
    "GET /proxy:/topics": { body: { items: [] } },
  };
}

const SETUP_STEPS: { stage: string; location: string; api: Record<string, any> }[] = [
  { stage: "llm", location: "/e/default/setup/llm", api: setupApi(false) },
  { stage: "persona", location: "/e/default/setup/persona", api: setupApi(true) },
  { stage: "soul", location: "/e/default/setup/soul", api: setupApi(true) },
  { stage: "done", location: "/e/default/setup/done", api: setupApi(true, true) },
  // Opened again from Settings.
  { stage: "llm", location: "/e/default/setup/llm?reentry=settings", api: setupApi(true, true) },
];

test("setup: every step has the proxy entry at the card's top, on a wide window and a narrow one", async () => {
  for (const step of SETUP_STEPS) {
    for (const width of [1280, 360]) {
      const shell = fakeShell();
      const { app } = await openConsole({ location: step.location, api: step.api, width, ...DESKTOP(shell) });
      const what = `${step.location} at ${width}`;
      await app.waitFor(`id:setup-stage-${step.stage}`);
      await app.waitFor("id:setup-kicker");
      expect([what, app.shows(`id:setup-stage-${step.stage} >> id:network-proxy-entry`)]).toEqual([what, true]);
      expect([what, app.shows("role:button[Network proxy]")]).toEqual([what, true]);
    }
  }
});

test("setup: the entry opens the proxy dialog and saves through the host; the step stays as it is", async () => {
  const shell = fakeShell();
  const { app, calls } = await openConsole({ location: "/e/default/setup/llm", api: setupApi(false), ...DESKTOP(shell) });
  await app.waitFor("id:setup-stage-llm");
  await app.type("id:setup-model", "gpt-test");
  await app.waitUntil(() => shell.counts.get === 1);
  const before = calls.length;
  await app.press("id:network-proxy-entry");
  await saveHTTPProxy(app);
  expect(shell.sets).toEqual([{ mode: "explicit", type: "http", host: "proxy.example", port: "8080", username: "" }]);
  expect(shell.counts.quit).toBe(0);
  expect(calls.slice(before)).toEqual([]);
  await app.press("id:dialog-action-later");
  await app.waitUntil(() => !app.shows("id:network-proxy-apply"));
  // The step and what was typed in it are kept.
  expect(app.shows("id:setup-stage-llm")).toBe(true);
  expect(app.value("id:setup-model")).toBe("gpt-test");
  await app.waitFor("id:network-proxy-entry-pending");
});

test("setup: no proxy entry in a browser, on a desktop host without the feature, or in the phone app", async () => {
  for (const [name, options] of WITHOUT) {
    const { app } = await openConsole({ location: "/e/default/setup/llm", api: setupApi(false), ...options });
    await app.waitFor("id:setup-stage-llm");
    await app.waitFor("id:setup-kicker");
    expect([name, app.shows("id:network-proxy-entry")]).toEqual([name, false]);
  }
});
