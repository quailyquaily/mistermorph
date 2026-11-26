// The desktop app's network proxy setting (components/settings/NetworkProxySetting.tsx): the row
// of General and its dialog, against a host that answers `morph.desktop.networkProxy.*` as the
// desktop shell does (desktop/nsh/src/proxy.rs). Where General shows the row: the last test.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";
import { openFixture } from "./fixtures/integrations-harness";

interface Saved {
  mode: "system" | "explicit";
  type: "http" | "socks5";
  host: string;
  port: number | null;
  username: string;
  hasPassword: boolean;
}

const SYSTEM: Saved = { mode: "system", type: "http", host: "", port: null, username: "", hasPassword: false };
const SECRET = "S3ntinel-pass";

/**
 * A host with the setting: it validates like the shell (enough for these tests), keeps the
 * password to itself, and counts what would start or stop a process.
 */
function fakeShell(options: { saved?: Saved; running?: Record<string, unknown>; credentialStore?: boolean; refuse?: Record<string, unknown> } = {}) {
  let saved: Saved = options.saved ?? SYSTEM;
  const running = options.running ?? { mode: "system" };
  const sets: any[] = [];
  const counts = { quit: 0, restart: 0 };
  let password = saved.hasPassword ? SECRET : "";
  const view = () => {
    const explicit = running.mode === "explicit";
    const pending = explicit
      ? saved.mode !== "explicit" || saved.type !== running.type || saved.host !== running.host || saved.port !== running.port
      : saved.mode === "explicit";
    return { saved, running, pending, credentialStore: options.credentialStore ?? true };
  };
  const handlers = {
    "morph.desktop.networkProxy.get": () => view(),
    "morph.desktop.networkProxy.set": (data: any) => {
      sets.push(data);
      if (options.refuse) return { ok: false, ...options.refuse };
      if (data.mode === "system") {
        saved = { ...saved, mode: "system", hasPassword: saved.hasPassword && !data.clearPassword };
        return { ok: true, ...view() };
      }
      const fields: Record<string, string> = {};
      if (!data.host) fields.host = "host_required";
      else if (/[/\s]/.test(data.host) || (data.host.includes(":") && !/^[0-9a-f:]+$/i.test(data.host))) fields.host = "host_invalid";
      if (!data.port) fields.port = "port_required";
      else if (!/^\d+$/.test(data.port) || Number(data.port) < 1 || Number(data.port) > 65535) fields.port = "port_invalid";
      if (String(data.username).includes(":")) fields.username = "username_invalid";
      const hasPassword = Boolean(data.password) || (saved.hasPassword && !data.clearPassword);
      if (hasPassword && !data.username) fields.password = "password_without_username";
      if (Object.keys(fields).length) return { ok: false, error: "validation", fields };
      if (data.password) password = data.password;
      saved = { mode: "explicit", type: data.type, host: data.host, port: Number(data.port), username: data.username, hasPassword };
      return { ok: true, ...view() };
    },
    "morph.desktop.quit": () => {
      counts.quit += 1;
      return null;
    },
    "morph.desktop.restart": () => {
      counts.restart += 1;
      return null;
    },
  };
  return { handlers, sets, counts, saved: () => saved, password: () => password };
}

async function openRow(shell: ReturnType<typeof fakeShell>, features = ["networkProxy", "quit", "restart"]) {
  const fixture = await openFixture({ view: "network-proxy", runtime: "desktop", features, host: shell.handlers });
  return fixture.app;
}

async function openDialog(app: App) {
  await app.waitFor("id:network-proxy-running");
  await app.press("id:network-proxy-open");
  await app.waitFor("id:network-proxy-dialog");
}

async function choose(app: App, title: string) {
  await app.press("label:Proxy");
  await app.press(`text:${title}`);
}

/** Nothing the app shows or was sent holds the password. */
function expectNoSecret(app: App, secret = SECRET) {
  expect(app.texts().filter((text) => text.includes(secret))).toEqual([]);
}

test("first use: System default, nothing pending, the fields wait for a proxy type", async () => {
  const shell = fakeShell();
  const app = await openRow(shell);
  await app.waitFor("id:network-proxy-running");
  expect(app.shows("text:In use: System default")).toBe(true);
  expect(app.shows("id:network-proxy-pending")).toBe(false);
  await openDialog(app);
  expect(app.shows("text:System default")).toBe(true);
  for (const id of ["network-proxy-host", "network-proxy-port", "network-proxy-username"]) {
    expect([id, app.enabled(`id:${id}`)]).toEqual([id, false]);
  }
  // The note says what is proxied, what is blocked and what is not; it does not say "all traffic".
  const note = app.texts().join("\n");
  expect(note).toContain("Through the proxy:");
  expect(note).toContain("Blocked, not proxied: the url_fetch tool");
  expect(note).toContain("Not through the proxy:");
  expect(note).toContain("other programs of your user account can read it");
  expect(note.toLowerCase()).not.toContain("all traffic");
  await choose(app, "SOCKS5");
  await app.waitUntil(() => app.enabled("id:network-proxy-host"));
  expect(app.enabled("id:network-proxy-port")).toBe(true);
});

test("a setting that fails validation is refused on its fields and nothing is saved", async () => {
  const shell = fakeShell();
  const app = await openRow(shell);
  await openDialog(app);
  await choose(app, "HTTP");
  await app.waitUntil(() => app.enabled("id:network-proxy-host"));
  await app.press("id:network-proxy-dialog-save");
  await app.waitFor("text:Enter the proxy's host.");
  expect(app.shows("text:Enter the proxy's port.")).toBe(true);
  await app.type("id:network-proxy-host", "http://proxy.example");
  await app.type("id:network-proxy-port", "65536");
  await app.type("id:network-proxy-username", "a:b");
  await app.press("id:network-proxy-dialog-save");
  await app.waitFor("text:Enter a host name or an IP address only: no http://, port, path or spaces.");
  expect(app.shows("text:The port is a number from 1 to 65535.")).toBe(true);
  expect(app.shows("text:The user name cannot contain a colon or control characters.")).toBe(true);
  // The dialog stays, and the saved setting is what it was.
  expect(app.shows("id:network-proxy-dialog")).toBe(true);
  expect(shell.saved()).toEqual(SYSTEM);
  expect(shell.counts).toEqual({ quit: 0, restart: 0 });
});

test("saving stores the setting and nothing else; Later leaves the app as it is and the row says what is pending", async () => {
  const shell = fakeShell();
  const app = await openRow(shell);
  await openDialog(app);
  await choose(app, "HTTP");
  await app.waitUntil(() => app.enabled("id:network-proxy-host"));
  await app.type("id:network-proxy-host", " proxy.example ");
  await app.type("id:network-proxy-port", "8080");
  await app.type("id:network-proxy-username", "morph");
  await app.type("id:network-proxy-password-input", SECRET);
  await app.press("id:network-proxy-dialog-save");
  // It applies after quitting and reopening, and quitting stops running tasks.
  await app.waitFor("id:network-proxy-apply");
  expect(app.shows("text:Quit and reopen to apply")).toBe(true);
  expect(app.texts().some((text) => text.includes("Quitting stops running tasks") && text.includes("does not reopen by itself"))).toBe(true);
  expect(shell.sets).toEqual([
    { mode: "explicit", type: "http", host: "proxy.example", port: "8080", username: "morph", password: SECRET },
  ]);
  expect(shell.saved()).toEqual({ mode: "explicit", type: "http", host: "proxy.example", port: 8080, username: "morph", hasPassword: true });
  // Save alone starts or stops nothing.
  expect(shell.counts).toEqual({ quit: 0, restart: 0 });

  await app.press("id:dialog-action-later");
  await app.waitUntil(() => !app.shows("id:network-proxy-apply"));
  expect(shell.counts).toEqual({ quit: 0, restart: 0 });
  // The running state is still the one the app started with.
  expect(app.shows("text:In use: System default")).toBe(true);
  expect(app.shows("id:network-proxy-pending")).toBe(true);
  expectNoSecret(app);
});

test("Quit now asks first, says running tasks will be stopped, and quits only when confirmed", async () => {
  const shell = fakeShell();
  const app = await openRow(shell);
  await openDialog(app);
  await choose(app, "SOCKS5");
  await app.waitUntil(() => app.enabled("id:network-proxy-host"));
  await app.type("id:network-proxy-host", "10.0.0.2");
  await app.type("id:network-proxy-port", "1080");
  await app.press("id:network-proxy-dialog-save");
  await app.waitFor("id:network-proxy-apply");

  await app.press("id:dialog-action-quit");
  await app.waitFor("text:Quit the app now?");
  expect(app.shows("text:Running tasks will be stopped. Reopen the app yourself to use the new proxy setting.")).toBe(true);
  expect(shell.counts.quit).toBe(0);
  await app.press("id:dialog-action-cancel");
  await app.waitUntil(() => !app.shows("text:Quit the app now?"));
  expect(shell.counts.quit).toBe(0);

  await app.press("id:dialog-action-quit");
  await app.waitFor("text:Quit the app now?");
  await app.press("id:dialog-action-confirm");
  await app.waitUntil(() => shell.counts.quit === 1);
  // Quit, never a restart or a relaunch.
  expect(shell.counts.restart).toBe(0);
});

test("the stored password is write-only: untouched it is kept, and it can be removed", async () => {
  const stored: Saved = { mode: "explicit", type: "socks5", host: "2001:db8::1", port: 1080, username: "morph", hasPassword: true };
  const running = { mode: "explicit", type: "socks5", host: "2001:db8::1", port: 1080, username: "morph" };
  const shell = fakeShell({ saved: stored, running });
  const app = await openRow(shell);
  await app.waitFor("id:network-proxy-running");
  // The row names the running proxy by type, host and port.
  expect(app.shows("text:In use: SOCKS5 [2001:db8::1]:1080")).toBe(true);
  expect(app.shows("id:network-proxy-pending")).toBe(false);
  await openDialog(app);
  expect(app.value("id:network-proxy-host")).toBe("2001:db8::1");
  expect(app.value("id:network-proxy-port")).toBe("1080");
  expect(app.value("id:network-proxy-username")).toBe("morph");
  // A stored password shows as stored, not as text.
  expect(app.shows("id:network-proxy-password-input")).toBe(false);
  expect(app.shows("id:network-proxy-password-clear")).toBe(true);
  expectNoSecret(app);

  // Saving the running values: nothing pending, no password sent.
  await app.press("id:network-proxy-dialog-save");
  await app.waitUntil(() => !app.shows("id:network-proxy-dialog"));
  expect(shell.sets[0]).toEqual({ mode: "explicit", type: "socks5", host: "2001:db8::1", port: "1080", username: "morph" });
  expect(app.shows("id:network-proxy-apply")).toBe(false);
  expect(app.shows("id:network-proxy-pending")).toBe(false);
  expect(shell.password()).toBe(SECRET);

  // Removing it is said before it happens, and happens on Save.
  await openDialog(app);
  await app.press("id:network-proxy-password-clear");
  await app.waitFor("text:The stored password is removed when you save.");
  expect(shell.saved().hasPassword).toBe(true);
  await app.press("id:network-proxy-dialog-save");
  await app.waitUntil(() => shell.sets.length === 2);
  expect(shell.sets[1]).toEqual({ mode: "explicit", type: "socks5", host: "2001:db8::1", port: "1080", username: "morph", clearPassword: true });
  await app.waitUntil(() => shell.saved().hasPassword === false);
  expectNoSecret(app);
});

test("switching to System default keeps the saved fields and is pending until the app is reopened", async () => {
  const stored: Saved = { mode: "explicit", type: "http", host: "proxy.example", port: 8080, username: "", hasPassword: false };
  const shell = fakeShell({ saved: stored, running: { mode: "explicit", type: "http", host: "proxy.example", port: 8080, username: "" } });
  const app = await openRow(shell);
  await openDialog(app);
  await choose(app, "System default");
  await app.waitUntil(() => !app.enabled("id:network-proxy-host"));
  expect(app.value("id:network-proxy-host")).toBe("proxy.example");
  await app.press("id:network-proxy-dialog-save");
  await app.waitFor("id:network-proxy-apply");
  expect(shell.saved()).toEqual({ ...stored, mode: "system" });
  await app.press("id:dialog-action-later");
  await app.waitFor("id:network-proxy-pending");
  expect(app.shows("text:In use: HTTP proxy.example:8080")).toBe(true);
  expect(shell.counts).toEqual({ quit: 0, restart: 0 });
});

test("a password the credential store does not take is not saved, and the error holds no credential", async () => {
  const shell = fakeShell({
    credentialStore: false,
    refuse: { error: "credential_store", message: "no credential store is available" },
  });
  const app = await openRow(shell);
  await openDialog(app);
  await app.waitFor("id:network-proxy-no-store");
  await choose(app, "HTTP");
  await app.waitUntil(() => app.enabled("id:network-proxy-host"));
  await app.type("id:network-proxy-host", "proxy.example");
  await app.type("id:network-proxy-port", "8080");
  await app.type("id:network-proxy-username", "morph");
  await app.type("id:network-proxy-password-input", SECRET);
  await app.press("id:network-proxy-dialog-save");
  await app.waitFor("id:network-proxy-save-error");
  expect(app.shows("text:The password could not be saved in the system's credential store: no credential store is available")).toBe(true);
  expect(app.shows("id:network-proxy-dialog")).toBe(true);
  expect(app.shows("id:network-proxy-apply")).toBe(false);
  expectNoSecret(app);
  expect(shell.saved()).toEqual(SYSTEM);
});

test("only a host with the feature shows the row: the desktop app, not a browser or the phone app", async () => {
  // The component is mounted where the host has the feature.
  const without = await openFixture({ view: "network-proxy", runtime: "desktop", features: ["quit"] });
  await without.app.waitFor("id:no-network-proxy");
  expect(without.app.shows("id:network-proxy")).toBe(false);

  const GENERAL = "/e/default/settings/general";
  const shell = fakeShell();
  const desktop = await openConsole({ location: GENERAL, runtime: "desktop", features: ["networkProxy", "quit"], host: shell.handlers });
  await desktop.app.waitFor("id:settings-logout");
  await desktop.app.waitFor("id:settings-general >> id:network-proxy");
  await desktop.app.waitFor("text:In use: System default");
  await desktop.app.type("id:settings-search", "proxy");
  await desktop.app.waitFor("id:settings-search-results");
  await desktop.app.waitFor("role:option[Network proxy]");

  const cases: [string, Parameters<typeof openConsole>[0]][] = [
    ["browser", {}],
    ["desktop without the feature", { runtime: "desktop" }],
    ["Android", { platform: "android", width: 1280, height: 800 }],
  ];
  for (const [name, options] of cases) {
    const { app } = await openConsole({ location: GENERAL, ...options });
    await app.waitFor("id:settings-logout");
    expect([name, app.shows("id:network-proxy")]).toEqual([name, false]);
    await app.type("id:settings-search", "proxy");
    await app.waitFor("id:settings-search-results");
    expect([name, app.shows("role:option[Network proxy]")]).toEqual([name, false]);
  }
});
