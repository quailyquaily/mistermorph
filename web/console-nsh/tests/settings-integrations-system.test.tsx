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

test("Updates: shows the version, finds a release, opens its download and copies its checksum", async () => {
  const { app, calls } = await openFixture({
    view: "app",
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": {
        body: {
          update_available: true,
          channel: "community",
          current_version: "0.9.0",
          latest_version: "1.0.0",
          release_date: "2026-10-01T00:00:00Z",
          release_notes: `## Changelog\n- ${SHA} Faster startup`,
          checksum: "sha256:aaaaaaaaaaaabbbbbbbbbbbbccccccccdddddddd",
          asset_url: "https://downloads.example/morph-1.0.0.dmg",
        },
      },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  expect(app.texts()).toContain("Not checked yet");
  await app.press("id:settings-update-check");
  await app.waitFor("v1.0.0 is available.");
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("channel")).toBe("community");
  await app.waitFor("Community v1.0.0");
  expect(app.texts().some((text) => text.includes("Faster startup"))).toBe(true);
  expect(app.texts().some((text) => text.includes("Changelog"))).toBe(false);
  await app.press("id:settings-update-download");
  expect(app.openedUrls()).toContain("https://downloads.example/morph-1.0.0.dmg");
  await app.press("All releases");
  expect(app.openedUrls()).toContain("https://mistermorph.com/releases/?channel=community");
  await app.press("id:settings-update-checksum");
  await app.waitFor("Checksum copied.");
  expect(app.clipboard()).toBe("sha256:aaaaaaaaaaaabbbbbbbbbbbbccccccccdddddddd");
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
      "morph.desktop.checkUpdate": { status: "current_version_unknown", channel: "pro", latest_version: "2.0.0", current_version: "dev" },
    },
  });
  await app.waitFor("v1.2.3 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Development build. The latest Pro release is v2.0.0.");
  expect(calls.some((call) => call.path === "/settings/auto-update/check")).toBe(false);
  expect(app.host.calls().some((call) => call.name === "morph.desktop.checkUpdate")).toBe(true);
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
