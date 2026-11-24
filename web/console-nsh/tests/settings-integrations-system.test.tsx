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
  await app.waitFor("Installed: v0.9.0");
  expect(app.texts()).toContain("Not checked yet");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
  await app.press("id:settings-update-check");
  await app.waitFor("Available: v1.0.0");
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("channel")).toBe("community");
  expect(check?.query.get("download_os")).toBe("darwin");
  expect(check?.query.get("download_arch")).toBe("arm64");
  // The release is told once, in the shared notes, as the server's.
  await app.waitFor("Server · v1.0.0");
  expect(app.count("id:settings-update-note")).toBe(1);
  expect(app.texts().some((text) => text.includes("Faster startup"))).toBe(true);
  expect(app.texts().some((text) => text.includes("Changelog"))).toBe(false);
  expect(app.texts()).toContain("Download for macOS (Apple silicon)");
  await app.press("id:settings-update-server-download");
  expect(app.openedUrls()).toContain("https://downloads.example/morph-1.0.0.dmg");
  expect(app.openedUrls()).not.toContain(SERVER_ASSET.asset_url);
  // An icon button, named by its former label; the checksum is text beside its copy button.
  expect(app.texts()).not.toContain("All releases");
  await app.press("label:All releases");
  expect(app.openedUrls()).toContain("https://mistermorph.com/releases/?channel=community");
  expect(app.texts()).toContain("SHA256");
  expect(app.shows("id:settings-update-server-checksum-value")).toBe(true);
  await app.press("id:settings-update-server-checksum");
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("download_os")).toBe("android");
  expect(check?.query.has("download_arch")).toBe(false);
  await app.press("id:settings-update-server-download");
  expect(app.openedUrls()).toEqual([APK]);
  await app.press("id:settings-update-server-checksum");
  await app.waitFor("Checksum copied.");
  expect(app.clipboard()).toBe("sha256:" + "a".repeat(64));
});

test("Updates: an older server without a download offers its file only to the same platform", async () => {
  // The server answers as before this change: only its own file, for linux-amd64.
  const api = { "GET /settings/auto-update": { body: AUTO_UPDATE }, "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } } };
  const android = await openFixture({ view: "app", host: { "morph.client.platform": BROWSER.android }, api });
  await android.app.waitFor("Installed: v0.9.0");
  await android.app.press("id:settings-update-check");
  await android.app.waitFor("Pick a download for this device on the releases page.");
  expect(android.app.shows("id:settings-update-server-download")).toBe(false);
  expect(android.app.shows("id:settings-update-server-checksum")).toBe(false);
  await android.app.press("id:settings-update-server-open-releases");
  expect(android.app.openedUrls()).toEqual(["https://mistermorph.com/releases/?channel=community"]);

  const linux = await openFixture({ view: "app", host: { "morph.client.platform": BROWSER.linuxAmd64 }, api });
  await linux.app.waitFor("Installed: v0.9.0");
  await linux.app.press("id:settings-update-check");
  await linux.app.waitFor("Download for Linux (x86-64)");
  await linux.app.press("id:settings-update-server-download");
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("Pick the build for this device.");
  expect(calls.find((call) => call.path === "/settings/auto-update/check")?.query.has("download_arch")).toBe(false);
  expect(app.texts()).toContain("Download for Linux (x86-64)");
  expect(app.texts()).toContain("Download for Linux (ARM64)");
  // No single file, so no single checksum.
  expect(app.shows("id:settings-update-server-checksum")).toBe(false);
  await app.press("id:settings-update-server-download-linux-arm64");
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't tell which system this device runs. Pick a download on the releases page.");
  expect(calls.find((call) => call.path === "/settings/auto-update/check")?.query.get("download_os")).toBe("");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
  expect(app.shows("id:settings-update-server-checksum")).toBe(false);
  await app.press("id:settings-update-server-open-releases");
  expect(app.openedUrls()).toEqual(["https://mistermorph.com/releases/?channel=community"]);

  download = { status: "unavailable", reason: "unreachable", os: "android" };
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't load this release's downloads. Pick one on the releases page.");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("This release has no download for Android.");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
  expect(app.shows("id:settings-update-server-open-releases")).toBe(true);
});

test("Updates: a failed check drops the last download and its notes", async () => {
  let fail = false;
  const { app } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.android },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": () =>
        fail
          ? { status: 502, body: { error: "release feed unreachable" } }
          : { body: { ...RELEASE, ...SERVER_ASSET, download: { status: "available", os: "android", url: APK } } },
    },
  });
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  fail = true;
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't check for updates: release feed unreachable");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
  expect(app.shows("id:settings-update-server-open-releases")).toBe(false);
  expect(app.shows("id:settings-update-notes")).toBe(false);

  fail = false;
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  expect(app.shows("id:settings-update-notes")).toBe(true);
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("Couldn't check for updates: release feed unreachable");
  fail = false;
  await app.press("id:settings-update-check");
  await app.waitFor("Up to date");
  expect(app.shows("id:settings-update-server-release")).toBe(false);
  expect(app.shows("id:settings-update-notes")).toBe(false);
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-auto");
  await app.waitUntil(() => eventsNamed("update.revision").length === 1);
  const put = calls.find((call) => call.method === "PUT");
  expect(put?.json).toEqual({ config_revision: "rev-1", auto_update: { enabled: true } });
  expect(eventsNamed("update.revision")[0].data).toBe("r-2");
  await app.press("id:settings-update-auto");
  await app.waitFor("config changed on disk");
  await app.waitUntil(() => calls.filter((call) => call.method === "GET" && call.path === "/settings/auto-update").length === 2);
});

/** Whether a row's update state reads `text`. */
const says = (app: { shows(selector: string): boolean }, target: "shell" | "server", text: string) =>
  app.shows(`id:settings-update-${target}-state >> text:${text}`);

const DESKTOP_CHECK = {
  status: "current_version_unknown",
  channel: "pro",
  latest_version: "2.0.0",
  current_version: "dev",
  platform: "macos-arm64",
  asset_url: "https://downloads.example/MrMorph-darwin-arm64.tar.gz",
  checksum: "sha256:desktop",
};

test("Updates: the desktop app's version is the shell's, the server's its own; one check asks the host for the shell and the server for itself", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
    host: { "morph.desktop.checkUpdate": DESKTOP_CHECK },
  });
  await app.waitFor("Installed: v1.2.3 · Desktop app");
  expect(app.texts()).toContain("Installed: v0.9.0");
  expect(app.texts()).toContain("Shell version");
  expect(app.texts()).toContain("Server version");
  expect(says(app, "shell", "Not checked yet")).toBe(true);
  expect(says(app, "server", "Not checked yet")).toBe(true);
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "shell", "Development build. The latest release is v2.0.0."));
  await app.waitUntil(() => says(app, "server", "Available: v1.0.0"));
  // Each component was asked once, by its own check: the host for the shell, the server for itself.
  expect(app.host.calls().filter((call) => call.name === "morph.desktop.checkUpdate")).toHaveLength(1);
  const checks = calls.filter((call) => call.path === "/settings/auto-update/check");
  expect(checks).toHaveLength(1);
  // The server's check names no device: there is a shell to update here.
  expect(checks[0].query.has("download_os")).toBe(false);
  expect(app.host.calls().some((call) => call.name === "morph.client.platform")).toBe(false);
  // The shell's own file, under the plain label as before; opening it is the reader's own press.
  expect(app.openedUrls()).toEqual([]);
  expect(app.texts()).toContain("Download");
  await app.press("id:settings-update-shell-download");
  expect(app.openedUrls()).toEqual(["https://downloads.example/MrMorph-darwin-arm64.tar.gz"]);
  // The server's is not this machine's: the releases page, never the server's own file.
  await app.waitFor("The server updates where it runs. Its builds are on the releases page.");
  expect(app.shows("id:settings-update-server-download")).toBe(false);
  await app.press("id:settings-update-server-open-releases");
  expect(app.openedUrls()).toContain("https://mistermorph.com/releases/?channel=community");
  // The versions stay where they came from.
  expect(app.texts()).toContain("Installed: v1.2.3 · Desktop app");
  expect(app.texts()).toContain("Installed: v0.9.0");
});

/** The titles of the shared notes' entries ("Shell and server · v1.0.0"), in order. */
const noteTitles = (app: { texts(): string[] }) => app.texts().filter((text) => /^(Shell|Server|Shell and server) · v/.test(text));

test("Updates: no channel to pick and no Pro; every check reads Community, whatever channel is saved", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: {
      // A server whose settings hold the Pro channel.
      "GET /settings/auto-update": { body: { ...AUTO_UPDATE, auto_update: { enabled: false, channel: "pro" } } },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
    host: { "morph.desktop.checkUpdate": { ...DESKTOP_CHECK, channel: "community" } },
  });
  await app.waitFor("Installed: v0.9.0");
  expect(app.shows("id:settings-update-channel")).toBe(false);
  expect(app.count("label:Release channel")).toBe(0);
  expect(app.texts().some((text) => /\bPro\b|Release channel|Community/.test(text))).toBe(false);
  // One control checks: no check button of the shell's or the server's own.
  expect(app.count("id:settings-update-check")).toBe(1);
  expect(app.count("label:Check for updates")).toBe(1);
  expect(app.shows("id:settings-update-shell-check")).toBe(false);
  expect(app.shows("id:settings-update-server-check")).toBe(false);
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "server", "Available: v1.0.0"));
  await app.waitUntil(() => says(app, "shell", "Development build. The latest release is v2.0.0."));
  expect(calls.find((call) => call.path === "/settings/auto-update/check")?.query.get("channel")).toBe("community");
  expect(app.host.calls().find((call) => call.name === "morph.desktop.checkUpdate")?.data).toEqual({ channel: "community" });
  // Checking saved nothing: the stored channel is as it was.
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
  // The automatic-updates switch saves itself only, never a channel.
  await app.press("id:settings-update-auto");
  await app.waitUntil(() => calls.some((call) => call.method === "PUT"));
  expect(calls.find((call) => call.method === "PUT")?.json.auto_update).toEqual({ enabled: true });
});

test("Updates: while the checks run the one button is off and says so; a press then asks nothing again", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      // The server takes its time; the shell's host answers at once.
      "POST /settings/auto-update/check": () => new Promise((resolve) => setTimeout(() => resolve({ body: { ...RELEASE, ...SERVER_ASSET } }), 400)),
    },
    host: { "morph.desktop.checkUpdate": DESKTOP_CHECK },
  });
  const serverChecks = () => calls.filter((call) => call.path === "/settings/auto-update/check");
  const shellChecks = () => app.host.calls().filter((call) => call.name === "morph.desktop.checkUpdate");
  await app.waitFor("Installed: v0.9.0");
  void app.press("id:settings-update-check").catch(() => {});
  await app.waitUntil(() => says(app, "server", "Checking for updates…"));
  // The shell's answer is shown while the server's is awaited; the button stays off until both end.
  await app.waitUntil(() => says(app, "shell", "Development build. The latest release is v2.0.0."));
  expect(app.enabled("id:settings-update-check")).toBe(false);
  await app.press("id:settings-update-check").catch(() => {});
  await app.waitUntil(() => says(app, "server", "Available: v1.0.0"));
  expect(serverChecks()).toHaveLength(1);
  expect(shellChecks()).toHaveLength(1);
  // Once both ended, a press is another round: each component asked once more.
  await app.waitUntil(() => app.enabled("id:settings-update-check"));
  await app.press("id:settings-update-check");
  await app.waitUntil(() => serverChecks().length === 2 && shellChecks().length === 2);
  await app.waitUntil(() => app.enabled("id:settings-update-check"));
  expect(serverChecks()).toHaveLength(2);
  expect(shellChecks()).toHaveLength(2);
});

test("Updates: the server's check failing leaves the shell's answer, its download and its notes", async () => {
  const { app } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { status: 502, body: { error: "release feed unreachable" } },
    },
    host: { "morph.desktop.checkUpdate": { ...DESKTOP_CHECK, status: "update_available", update_available: true, current_version: "1.2.3", release_notes: "- Shell fix" } },
  });
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "server", "Couldn't check for updates: release feed unreachable"));
  await app.waitUntil(() => says(app, "shell", "Available: v2.0.0"));
  expect(app.shows("id:settings-update-shell-download")).toBe(true);
  expect(app.shows("id:settings-update-server-release")).toBe(false);
  expect(noteTitles(app)).toEqual(["Shell · v2.0.0"]);
  expect(app.texts().some((text) => text.includes("Shell fix"))).toBe(true);
  expect(app.enabled("id:settings-update-check")).toBe(true);
});

test("Updates: the shell's check failing leaves the server's answer and its notes", async () => {
  const { app } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
    // No `morph.desktop.checkUpdate`: the host's check fails.
  });
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "server", "Available: v1.0.0"));
  await app.waitUntil(() => app.shows("id:settings-update-shell-state >> text:/^Couldn't check for updates: /"));
  expect(app.shows("id:settings-update-shell-release")).toBe(false);
  expect(app.shows("id:settings-update-server-open-releases")).toBe(true);
  expect(noteTitles(app)).toEqual(["Server · v1.0.0"]);
  expect(app.texts().some((text) => text.includes("Faster startup"))).toBe(true);
});

test("Updates: one release for both is told once, for both; different releases each have their entry", async () => {
  let shellAnswer: Record<string, unknown> = {
    ...DESKTOP_CHECK,
    status: "update_available",
    update_available: true,
    channel: "community",
    current_version: "0.9.0",
    latest_version: "1.0.0",
    // The same notes, spaced otherwise.
    release_notes: `## Changelog\n\n-   ${SHA}   Faster startup\n`,
  };
  const { app } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
    host: { "morph.desktop.checkUpdate": () => shellAnswer },
  });
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "shell", "Available: v1.0.0") && says(app, "server", "Available: v1.0.0"));
  expect(noteTitles(app)).toEqual(["Shell and server · v1.0.0"]);
  expect(app.texts().filter((text) => text.includes("Faster startup"))).toHaveLength(1);
  expect(app.count("id:settings-update-all-releases")).toBe(1);
  // Each keeps its own download under its own row.
  expect(app.shows("id:settings-update-shell-download")).toBe(true);
  expect(app.shows("id:settings-update-server-open-releases")).toBe(true);

  // Another version for the shell: its own entry, the shell's first.
  shellAnswer = { ...shellAnswer, latest_version: "2.0.0", release_notes: "- New window" };
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "shell", "Available: v2.0.0"));
  await app.waitUntil(() => noteTitles(app).length === 2);
  expect(noteTitles(app)).toEqual(["Shell · v2.0.0", "Server · v1.0.0"]);
  expect(app.texts().some((text) => text.includes("New window"))).toBe(true);
  expect(app.texts().filter((text) => text.includes("Faster startup"))).toHaveLength(1);

  // The same version with other notes is not passed off as one release.
  shellAnswer = { ...shellAnswer, latest_version: "1.0.0", release_notes: "- Shell only fix" };
  await app.press("id:settings-update-check");
  await app.waitUntil(() => app.texts().some((text) => text.includes("Shell only fix")));
  expect(noteTitles(app)).toEqual(["Shell · v1.0.0", "Server · v1.0.0"]);
});

test("Updates: a server that cannot be read is Unknown, never the desktop app's version", async () => {
  const { app } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    api: { "GET /settings/auto-update": { status: 502, body: { error: "backend unreachable" } } },
    host: { "morph.desktop.checkUpdate": DESKTOP_CHECK },
  });
  await app.waitFor("backend unreachable");
  expect(app.texts()).toContain("Installed: v1.2.3 · Desktop app");
  expect(app.texts()).toContain("Installed: Unknown");
  expect(app.texts().filter((text) => text.includes("v1.2.3"))).toEqual(["Installed: v1.2.3 · Desktop app"]);
});

test("Updates: a desktop host that does not tell its version is Unknown, never the server's; without a check it says so", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    runtime: "desktop",
    // An older desktop host: no update check.
    features: [],
    boot: { desktopVersion: "" },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { channel: "community", latest_version: "0.9.0" } },
    },
  });
  await app.waitFor("Installed: v0.9.0");
  expect(app.texts()).toContain("Installed: Unknown · Desktop app");
  expect(says(app, "shell", "Update checks aren't available for this app.")).toBe(true);
  // The one button still checks what can be checked: the server only.
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "server", "Up to date"));
  expect(says(app, "shell", "Update checks aren't available for this app.")).toBe(true);
  expect(calls.filter((call) => call.path === "/settings/auto-update/check")).toHaveLength(1);
  expect(app.host.calls().some((call) => call.name === "morph.desktop.checkUpdate")).toBe(false);
  expect(app.shows("id:settings-update-shell-release")).toBe(false);
});

test("Updates: a host's `shell` is the shell's version", async () => {
  const { app } = await openFixture({
    view: "app",
    runtime: "desktop",
    features: ["checkUpdate"],
    boot: { desktopVersion: "", shell: { version: "1.4.0", build: "7" } },
    api: { "GET /settings/auto-update": { body: AUTO_UPDATE } },
    host: { "morph.desktop.checkUpdate": DESKTOP_CHECK },
  });
  await app.waitFor("Installed: v1.4.0 · Desktop app");
});

test("Updates: a browser has no shell: only the server's version and check", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.linuxAmd64 },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
  });
  await app.waitFor("Installed: v0.9.0");
  expect(app.texts()).toContain("Server version");
  expect(app.texts()).not.toContain("Shell version");
  expect(app.shows("id:settings-update-shell")).toBe(false);
  expect(app.count("id:settings-update-check")).toBe(1);
  expect(app.texts().some((text) => text.includes("Desktop app") || text.includes("Android app") || text.includes("iOS app"))).toBe(false);
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "server", "Available: v1.0.0"));
  // The browser's check still names this device's download, and it is the only check.
  expect(calls.filter((call) => call.path === "/settings/auto-update/check")).toHaveLength(1);
  expect(calls.find((call) => call.path === "/settings/auto-update/check")?.query.get("download_os")).toBe("linux");
  expect(noteTitles(app)).toEqual(["Server · v1.0.0"]);
});

test("Updates: another server starts over: its own version, no last server's result, Unknown when it fails", async () => {
  const { app } = await openFixture({
    view: "app",
    host: { "morph.client.platform": BROWSER.linuxAmd64 },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
      "GET /proxy": (request) => {
        if (request.query.get("uri") !== "/settings/auto-update") return { status: 404, body: { error: "no stub" } };
        return request.query.get("endpoint") === "ep_new"
          ? { body: { ...AUTO_UPDATE, current_version: "1.1.0", build_channel: "pro" } }
          : { status: 502, body: { error: "server unreachable" } };
      },
    },
  });
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitUntil(() => says(app, "server", "Available: v1.0.0"));
  await app.waitFor("id:settings-update-server-release");

  await app.host.send("morph.fixture.endpoint", "ep_new");
  // A build of another channel than the one checked says so beside its version.
  await app.waitFor("Installed: v1.1.0 · Pro");
  expect(app.texts()).not.toContain("Installed: v0.9.0");
  expect(says(app, "server", "Not checked yet")).toBe(true);
  expect(app.shows("id:settings-update-server-release")).toBe(false);
  expect(app.shows("id:settings-update-notes")).toBe(false);

  await app.host.send("morph.fixture.endpoint", "ep_gone");
  await app.waitFor("server unreachable");
  await app.waitUntil(() => app.texts().includes("Installed: Unknown"));
  expect(app.texts().some((text) => text.includes("v1.1.0") || text.includes("v0.9.0"))).toBe(false);
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
  await app.waitFor("Installed: v0.9.0");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  url = "https://downloads.example/v1.0.1/MrMorph-android.apk";
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  await app.press("id:settings-update-server-download");
  expect(app.openedUrls()).toEqual(["https://downloads.example/v1.0.1/MrMorph-android.apk"]);
});
