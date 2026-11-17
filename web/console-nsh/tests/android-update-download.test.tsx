// The phone app's Updates card (Settings › System): two versions from two sources. The shell is the
// installed Android app, whose version the native part tells (`morph.shell.info`); the server is
// the console server the app is connected to. A shell check looks up the release's Android app
// and compares it with the installed version; a server check is the server's own. A Linux server's
// own file is never offered on the phone, and neither version ever stands in for the other.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const QUIET = {
  "GET /proxy:/todo/tasks": { body: { items: [] } },
  "GET /proxy:/tasks": { body: { items: [] } },
  "GET /proxy:/topics": { body: { items: [] } },
};
const AUTO_UPDATE = {
  auto_update: { enabled: false, channel: "community" },
  build_channel: "community",
  current_version: "0.9.0",
  config_revision: "r-1",
};
const RELEASE = { update_available: true, channel: "community", current_version: "0.9.0", latest_version: "1.0.0", release_date: NOW };
const SERVER_ASSET = { platform: "linux-amd64", asset_url: "https://downloads.example/MrMorph-linux-amd64.tar.gz", checksum: "sha256:" + "f".repeat(64) };
const APK = "https://downloads.example/community/releases/v1.0.0/MrMorph-android.apk";
const APK_DOWNLOAD = { status: "available", os: "android", platform: "android", url: APK, checksum: "sha256:" + "a".repeat(64) };
/** The installed APK as the native part tells it: older than the server. */
const SHELL = { version: "0.8.0", build: "8000" };

/** Whether a row's update state reads `text`. */
const says = (app: { shows(selector: string): boolean }, target: "shell" | "server", text: string) => app.shows(`id:settings-update-${target}-state >> text:${text}`);

test("the shell's version and the server's are each their own; the shell check downloads the Android app", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [], "morph.shell.info": SHELL },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": (request) =>
        request.query.get("download_os") === "android"
          ? { body: { ...RELEASE, ...SERVER_ASSET, download: APK_DOWNLOAD } }
          : { body: { ...RELEASE, ...SERVER_ASSET, download: { status: "unavailable", reason: "unknown_platform" } } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  expect(app.texts()).toContain("Shell version");
  expect(app.texts()).toContain("Server version");
  expect(app.texts()).toContain("v0.8.0 · Android app");
  await app.press("id:settings-update-shell-check");
  await app.waitFor("Download for Android");
  expect(says(app, "shell", "v1.0.0 is available.")).toBe(true);
  // The server was not checked: its row still says so.
  expect(says(app, "server", "Not checked yet")).toBe(true);
  expect(says(app, "server", "v1.0.0 is available.")).toBe(false);
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("download_os")).toBe("android");
  // nsh does not tell the phone's ABI: none is claimed.
  expect(check?.query.has("download_arch")).toBe(false);
  // The phone asks nothing of a browser host.
  expect(app.host.calls().some((call) => call.name === "morph.client.platform")).toBe(false);
  await app.press("id:settings-update-shell-download");
  expect(app.openedUrls()).toEqual([APK]);
  // The installed version stays the native part's, not the server's answer's.
  expect(app.texts()).toContain("v0.8.0 · Android app");
});

test("the phone app with an older server: the releases page, not the server's Linux file", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [], "morph.shell.info": SHELL },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-shell-check");
  await app.waitFor("Pick a download for this device on the releases page.");
  expect(app.shows("id:settings-update-shell-download")).toBe(false);
  await app.press("id:settings-update-shell-open-releases");
  expect(app.openedUrls()).toEqual(["https://mistermorph.com/releases/?channel=community"]);
});

test("an up-to-date app beside an outdated server: each check says its own", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [], "morph.shell.info": { version: "1.0.0", build: "1000000" } },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": (request) => ({
        body: { ...RELEASE, ...SERVER_ASSET, ...(request.query.has("download_os") ? { download: APK_DOWNLOAD } : {}) },
      }),
    },
  });
  await app.waitFor("v1.0.0 · Android app");
  await app.press("id:settings-update-shell-check");
  await app.waitUntil(() => says(app, "shell", "You're on the latest Community release."));
  // Up to date: no release to offer for the app, though the server's answer had one for itself.
  expect(app.shows("id:settings-update-shell-release")).toBe(false);
  await app.press("id:settings-update-server-check");
  await app.waitUntil(() => says(app, "server", "v1.0.0 is available."));
  expect(says(app, "shell", "You're on the latest Community release.")).toBe(true);
  // The server's check names no device: its release points at the releases page for the server.
  const serverCheck = calls.filter((call) => call.path === "/settings/auto-update/check").at(-1);
  expect(serverCheck?.query.has("download_os")).toBe(false);
  await app.waitFor("The server updates where it runs. Its builds are on the releases page.");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
  expect(app.openedUrls()).toEqual([]);
});

test("without the native part the app's version is unknown, never the server's, and is not checked", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    // No `morph.shell.info`: an APK without the native part.
    host: { "morph.file.pick": [] },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, latest_version: "0.9.0", update_available: false } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  expect(app.texts()).toContain("Unknown · Android app");
  expect(app.texts().some((text) => text.includes("v0.9.0 · Android app"))).toBe(false);
  expect(says(app, "shell", "This app's version is unknown, so its updates can't be checked.")).toBe(true);
  expect(app.shows("id:settings-update-shell-check")).toBe(false);
  // The server is up to date; the app is still not called so.
  await app.press("id:settings-update-server-check");
  await app.waitUntil(() => says(app, "server", "You're on the latest Community release."));
  expect(says(app, "shell", "This app's version is unknown, so its updates can't be checked.")).toBe(true);
  expect(calls.filter((call) => call.path === "/settings/auto-update/check").every((call) => !call.query.has("download_os"))).toBe(true);
});

test("an unreachable server is an unknown server version; the app's own version stays", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [], "morph.shell.info": SHELL },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { status: 502, body: { error: "server unreachable" } },
    },
  });
  await app.waitFor("v0.8.0 · Android app");
  await app.waitUntil(() => app.texts().includes("Unknown"));
  expect(app.texts().some((text) => text.startsWith("v0.8.0 ·") && text !== "v0.8.0 · Android app")).toBe(false);
  expect(says(app, "shell", "Not checked yet")).toBe(true);
});
