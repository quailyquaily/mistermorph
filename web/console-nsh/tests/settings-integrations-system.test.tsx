// The App and Updates panels (SettingsAppPanel.tsx), Credits (SettingsCreditsPanel.tsx) and the
// notifications row (TopicNotificationSetting.tsx).
import { expect, test } from "nsh/test";
import { openFixture } from "./fixtures/integrations-harness";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const AUTO_UPDATE = {
  auto_update: { enabled: false, channel: "community" },
  build_channel: "community",
  current_version: "0.9.0",
  config_revision: "r-1",
};

test("App: names the selected agent and says how to install it from the browser", async () => {
  const { app } = await openFixture({
    view: "app",
    origin: "https://console.example",
    params: { endpoints: [{ endpoint_ref: "ep_1", agent_name: "Morph", name: "Console", connected: true }] },
    api: { "GET /settings/auto-update": { body: AUTO_UPDATE } },
  });
  await app.waitFor("Morph");
  expect(app.texts().some((text) => text.startsWith("The browser has not offered to install yet."))).toBe(true);
  expect(app.enabled("Install")).toBe(false);
});

test("App: without an agent it asks for one; on an insecure origin it says installing needs HTTPS", async () => {
  const none = await openFixture({ view: "app", api: { "GET /settings/auto-update": { body: AUTO_UPDATE } } });
  await none.app.waitFor("Select an agent to install it as an app.");
  const insecure = await openFixture({
    view: "app",
    origin: "http://10.0.0.5:9080",
    params: { endpoints: [{ endpoint_ref: "ep_1", agent_name: "Morph", connected: true }] },
    api: { "GET /settings/auto-update": { body: AUTO_UPDATE } },
  });
  await insecure.app.waitFor("Installing needs HTTPS (or localhost). Open the console over HTTPS to install it.");
  expect(insecure.app.shows("Install")).toBe(false);
});

test("App: in the desktop app it says so", async () => {
  const { app } = await openFixture({
    view: "app",
    runtime: "desktop",
    params: { endpoints: [{ endpoint_ref: "ep_1", agent_name: "Morph", connected: true }] },
    api: { "GET /settings/auto-update": { body: AUTO_UPDATE } },
  });
  await app.waitFor("Already running in the desktop app.");
});

// What host.js reads from a browser (`morph.client.platform`).
const BROWSER = {
  macChrome: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", uaPlatform: "macOS", architecture: "arm", bitness: "64" },
  android: { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile", platform: "Linux armv8l", uaPlatform: "Android" },
  linuxNoArch: { userAgent: "Mozilla/5.0 (X11; Linux)", platform: "Linux" },
  linuxAmd64: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" },
};
const RELEASE = {
  update_available: true,
  channel: "community",
  current_version: "0.9.0",
  latest_version: "1.0.0",
  release_date: "2026-10-01T00:00:00Z",
  release_notes: `## Changelog\n- ${SHA} Faster startup`,
};
// The server's own file: a Linux server's.
const SERVER_ASSET = { platform: "linux-amd64", asset_url: "https://downloads.example/MrMorph-linux-amd64.tar.gz", checksum: "sha256:" + "f".repeat(64) };
const APK = "https://downloads.example/MrMorph-android.apk";

test("Updates: shows the version, finds a release, opens this device's download and copies its checksum", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.macChrome },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": {
        body: {
          ...RELEASE,
          ...SERVER_ASSET,
          download: {
            status: "available",
            os: "darwin",
            arch: "arm64",
            url: "https://downloads.example/morph-1.0.0.dmg",
            checksum: "sha256:aaaaaaaaaaaabbbbbbbbbbbbccccccccdddddddd",
          },
        },
      },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  expect(app.texts()).toContain("Not checked yet");
  expect(app.shows("id:settings-update-download")).toBe(false);
  await app.press("id:settings-update-check");
  await app.waitFor("v1.0.0 is available.");
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("channel")).toBe("community");
  expect(check?.query.get("download_os")).toBe("darwin");
  expect(check?.query.get("download_arch")).toBe("arm64");
  await app.waitFor("Community v1.0.0");
  expect(app.texts().some((text) => text.includes("Faster startup"))).toBe(true);
  expect(app.texts().some((text) => text.includes("Changelog"))).toBe(false);
  expect(app.texts()).toContain("Download for macOS (Apple silicon)");
  await app.press("id:settings-update-download");
  expect(app.openedUrls()).toContain("https://downloads.example/morph-1.0.0.dmg");
  expect(app.openedUrls()).not.toContain(SERVER_ASSET.asset_url);
  await app.press("All releases");
  expect(app.openedUrls()).toContain("https://mistermorph.com/releases/?channel=community");
  await app.press("id:settings-update-checksum");
  await app.waitFor("Checksum copied.");
  expect(app.clipboard()).toBe("sha256:aaaaaaaaaaaabbbbbbbbbbbbccccccccdddddddd");
});

test("Updates: Android in a browser on a Linux server downloads the Android app, never the server's file", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.android },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": {
        body: { ...RELEASE, ...SERVER_ASSET, download: { status: "available", os: "android", url: APK, checksum: "sha256:" + "a".repeat(64) } },
      },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("download_os")).toBe("android");
  expect(check?.query.has("download_arch")).toBe(false);
  await app.press("id:settings-update-download");
  expect(app.openedUrls()).toEqual([APK]);
  await app.press("id:settings-update-checksum");
  await app.waitFor("Checksum copied.");
  expect(app.clipboard()).toBe("sha256:" + "a".repeat(64));
});

test("Updates: an older server without a download offers its file only to the same platform", async () => {
  // The server answers as before this change: only its own file, for linux-amd64.
  const api = { "GET /settings/auto-update": { body: AUTO_UPDATE }, "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } } };
  const android = await openFixture({ view: "app", host: { "morph.client.platform": BROWSER.android }, api });
  await android.app.waitFor("v0.9.0 · Community");
  await android.app.press("id:settings-update-check");
  await android.app.waitFor("Pick a download for this device on the releases page.");
  expect(android.app.shows("id:settings-update-download")).toBe(false);
  expect(android.app.shows("id:settings-update-checksum")).toBe(false);
  await android.app.press("id:settings-update-open-releases");
  expect(android.app.openedUrls()).toEqual(["https://mistermorph.com/releases/?channel=community"]);

  const linux = await openFixture({ view: "app", host: { "morph.client.platform": BROWSER.linuxAmd64 }, api });
  await linux.app.waitFor("v0.9.0 · Community");
  await linux.app.press("id:settings-update-check");
  await linux.app.waitFor("Download for Linux (x86-64)");
  await linux.app.press("id:settings-update-download");
  expect(linux.app.openedUrls()).toEqual([SERVER_ASSET.asset_url]);
});

test("Updates: a system of unknown architecture picks its build; each opens its own file", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.linuxNoArch },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": {
        body: {
          ...RELEASE,
          ...SERVER_ASSET,
          download: {
            status: "choose",
            os: "linux",
            options: [
              { platform: "linux-amd64", os: "linux", arch: "amd64", url: "https://downloads.example/MrMorph-linux-amd64.tar.gz", checksum: "sha256:1" },
              { platform: "linux-arm64", os: "linux", arch: "arm64", url: "https://downloads.example/MrMorph-linux-arm64.tar.gz", checksum: "sha256:2" },
            ],
          },
        },
      },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Pick the build for this device.");
  expect(calls.find((call) => call.path === "/settings/auto-update/check")?.query.has("download_arch")).toBe(false);
  expect(app.texts()).toContain("Download for Linux (x86-64)");
  expect(app.texts()).toContain("Download for Linux (ARM64)");
  // No single file, so no single checksum.
  expect(app.shows("id:settings-update-checksum")).toBe(false);
  await app.press("id:settings-update-download-linux-arm64");
  expect(app.openedUrls()).toEqual(["https://downloads.example/MrMorph-linux-arm64.tar.gz"]);
});

test("Updates: no download for an unknown system or an unpublished one; the releases page instead", async () => {
  let download: Record<string, unknown> = { status: "unavailable", reason: "unknown_platform" };
  const { app, calls } = await openFixture({
    view: "app",
    // No `morph.client.platform`: the host cannot tell.
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": () => ({ body: { ...RELEASE, ...SERVER_ASSET, download } }),
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't tell which system this device runs. Pick a download on the releases page.");
  expect(calls.find((call) => call.path === "/settings/auto-update/check")?.query.get("download_os")).toBe("");
  expect(app.shows("id:settings-update-download")).toBe(false);
  expect(app.shows("id:settings-update-checksum")).toBe(false);
  await app.press("id:settings-update-open-releases");
  expect(app.openedUrls()).toEqual(["https://mistermorph.com/releases/?channel=community"]);

  download = { status: "unavailable", reason: "unreachable", os: "android" };
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't load this release's downloads. Pick one on the releases page.");
  expect(app.shows("id:settings-update-download")).toBe(false);
});

test("Updates: the Android app's own message for a release without the app", async () => {
  const { app } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.android },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET, download: { status: "unavailable", reason: "not_published", os: "android" } } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("This release has no download for Android.");
  expect(app.shows("id:settings-update-download")).toBe(false);
  expect(app.shows("id:settings-update-open-releases")).toBe(true);
});

test("Updates: a failed check drops the last download; a new channel starts empty", async () => {
  let fail = false;
  const { app } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.android },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "PUT /settings/auto-update": (request) => ({ body: { auto_update: { enabled: false, ...request.json.auto_update }, config_revision: "r-2" } }),
      "POST /settings/auto-update/check": () =>
        fail
          ? { status: 502, body: { error: "release feed unreachable" } }
          : { body: { ...RELEASE, ...SERVER_ASSET, download: { status: "available", os: "android", url: APK } } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  fail = true;
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't check for updates: release feed unreachable");
  expect(app.shows("id:settings-update-download")).toBe(false);
  expect(app.shows("id:settings-update-open-releases")).toBe(false);

  fail = false;
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  await app.press("label:Release channel");
  await app.press("text:Pro");
  await app.waitFor("Not checked yet");
  expect(app.shows("id:settings-update-download")).toBe(false);
});

test("Updates: a failed check says why; up to date says so", async () => {
  let fail = true;
  const { app } = await openFixture({
    view: "app",
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": () =>
        fail ? { status: 500, body: { error: "release feed unreachable" } } : { body: { channel: "community", latest_version: "0.9.0" } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't check for updates: release feed unreachable");
  fail = false;
  await app.press("id:settings-update-check");
  await app.waitFor("You're on the latest Community release.");
  expect(app.shows("id:settings-update-release")).toBe(false);
});

test("Updates: automatic updates save with the page's revision; a failed save reloads", async () => {
  let puts = 0;
  const { app, calls, eventsNamed } = await openFixture({
    view: "app",
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "PUT /settings/auto-update": (request) => {
        puts += 1;
        return puts === 1
          ? { body: { auto_update: request.json.auto_update, config_revision: "r-2" } }
          : { status: 409, body: { error: "config changed on disk" } };
      },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-auto");
  await app.waitUntil(() => eventsNamed("update.revision").length === 1);
  const put = calls.find((call) => call.method === "PUT");
  expect(put?.json).toEqual({ config_revision: "rev-1", auto_update: { enabled: true } });
  expect(eventsNamed("update.revision")[0].data).toBe("r-2");
  await app.press("id:settings-update-auto");
  await app.waitFor("config changed on disk");
  await app.waitUntil(() => calls.filter((call) => call.method === "GET" && call.path === "/settings/auto-update").length === 2);
});

test("Updates: the desktop app checks through its host", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: { "GET /settings/auto-update": { body: AUTO_UPDATE } },
    host: {
      "morph.desktop.checkUpdate": {
        status: "current_version_unknown",
        channel: "pro",
        latest_version: "2.0.0",
        current_version: "dev",
        platform: "macos-arm64",
        asset_url: "https://downloads.example/MrMorph-darwin-arm64.tar.gz",
        checksum: "sha256:desktop",
      },
    },
  });
  await app.waitFor("v1.2.3 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Development build. The latest Pro release is v2.0.0.");
  expect(calls.some((call) => call.path === "/settings/auto-update/check")).toBe(false);
  expect(app.host.calls().some((call) => call.name === "morph.desktop.checkUpdate")).toBe(true);
  // Its own check is for its own machine: the file it found, under the plain label as before.
  expect(app.host.calls().some((call) => call.name === "morph.client.platform")).toBe(false);
  expect(app.texts()).toContain("Download");
  await app.press("id:settings-update-download");
  expect(app.openedUrls()).toEqual(["https://downloads.example/MrMorph-darwin-arm64.tar.gz"]);
});

test("Updates: a failed load shows a notice", async () => {
  const { app } = await openFixture({
    view: "app",
    api: { "GET /settings/auto-update": { status: 500, body: { error: "settings unavailable" } } },
  });
  await app.waitFor("settings unavailable");
});

test("Credits: contributors and projects, sorted by name; links open", async () => {
  const { app } = await openFixture({
    view: "credits",
    api: {
      "GET /settings/credits": {
        body: {
          contributors: [{ id: "c1", name: "Ada Lovelace", link: "https://example.org/ada" }],
          open_source: [
            { id: "p2", name: "zod", license: "MIT", summary: "Schemas", link: "https://zod.dev" },
            { id: "p1", name: "Axios", license: "MIT", summary: "HTTP", link: "" },
          ],
        },
      },
    },
  });
  await app.waitFor("Ada Lovelace");
  expect(app.texts()).toContain("AL");
  const texts = app.texts();
  expect(texts.indexOf("Axios")).toBeLessThan(texts.indexOf("zod"));
  await app.press("label:Open profile: Ada Lovelace");
  expect(app.openedUrls()).toContain("https://example.org/ada");
  await app.press("label:Open project");
  expect(app.openedUrls()).toContain("https://zod.dev");
});

test("Credits: empty lists and a failed load say so", async () => {
  const empty = await openFixture({ view: "credits", api: { "GET /settings/credits": { body: {} } } });
  await empty.app.waitFor("No contributor entries.");
  expect(empty.app.texts()).toContain("No open source entries.");
  const failed = await openFixture({ view: "credits", api: { "GET /settings/credits": { status: 500, body: { error: "credits broke" } } } });
  await failed.app.waitFor("id:settings-credits-error");
  expect(failed.app.texts()).toContain("credits broke");
});

test("Notifications: asks for the permission and shows the answer", async () => {
  const { app } = await openFixture({ view: "notifications", host: { "morph.notify.request": "granted" } });
  await app.waitFor("Notification permission has not been granted.");
  await app.press("Enable notifications");
  await app.waitFor("Notifications are enabled.");
  expect(app.enabled("Enable notifications")).toBe(false);
});

test("Notifications: blocked and unavailable states keep the button off", async () => {
  const denied = await openFixture({ view: "notifications", host: { "morph.notify.state": "denied" } });
  await denied.app.waitFor("Notifications are blocked. Change the permission in browser settings.");
  expect(denied.app.enabled("Enable notifications")).toBe(false);
  const unsupported = await openFixture({ view: "notifications", host: { "morph.notify.state": "unsupported" } });
  await unsupported.app.waitFor("Background notifications are unavailable in this browser context.");
});

test("Notifications on the desktop: the system's service answers, or its absence is said so", async () => {
  // The desktop app asks for no permission: a notification service that answers is "granted".
  const granted = await openFixture({ view: "notifications", runtime: "desktop", features: ["notifications"], host: { "morph.notify.state": "granted" } });
  await granted.app.waitFor("Notifications are enabled.");
  expect(granted.app.enabled("Enable notifications")).toBe(false);
  const missing = await openFixture({ view: "notifications", runtime: "desktop", features: ["notifications"], host: { "morph.notify.state": "unsupported" } });
  await missing.app.waitFor("Notifications are unavailable: the system's notification service did not answer.");
  expect(missing.app.enabled("Enable notifications")).toBe(false);
  expect(missing.app.texts()).not.toContain("Background notifications are unavailable in this browser context.");
});

test("Updates: a second check that finds another file offers that one", async () => {
  let url = "https://downloads.example/v1.0.0/MrMorph-android.apk";
  const { app } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.android },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": () => ({ body: { ...RELEASE, ...SERVER_ASSET, download: { status: "available", os: "android", url } } }),
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  url = "https://downloads.example/v1.0.1/MrMorph-android.apk";
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  await app.press("id:settings-update-download");
  expect(app.openedUrls()).toEqual(["https://downloads.example/v1.0.1/MrMorph-android.apk"]);
});
