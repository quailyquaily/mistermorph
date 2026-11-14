// The phone app's Updates card (Settings › System): the app is a client of a console server
// elsewhere, so a check asks for the Android app's download, and a Linux server's own file is never
// offered on the phone.
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

test("the phone app downloads the Android app from a Linux server's check", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [] },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": (request) =>
        request.query.get("download_os") === "android"
          ? { body: { ...RELEASE, ...SERVER_ASSET, download: { status: "available", os: "android", platform: "android", url: APK, checksum: "sha256:" + "a".repeat(64) } } }
          : { body: { ...RELEASE, ...SERVER_ASSET, download: { status: "unavailable", reason: "unknown_platform" } } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Download for Android");
  const check = calls.find((call) => call.path === "/settings/auto-update/check");
  expect(check?.query.get("download_os")).toBe("android");
  // nsh does not tell the phone's ABI: none is claimed.
  expect(check?.query.has("download_arch")).toBe(false);
  // The phone asks nothing of a browser host.
  expect(app.host.calls().some((call) => call.name === "morph.client.platform")).toBe(false);
  await app.press("id:settings-update-download");
  expect(app.openedUrls()).toEqual([APK]);
});

test("the phone app with an older server: the releases page, not the server's Linux file", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [] },
    api: {
      ...QUIET,
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET } },
    },
  });
  await app.waitFor("v0.9.0 · Community");
  await app.press("id:settings-update-check");
  await app.waitFor("Pick a download for this device on the releases page.");
  expect(app.shows("id:settings-update-download")).toBe(false);
  await app.press("id:settings-update-open-releases");
  expect(app.openedUrls()).toEqual(["https://mistermorph.com/releases/?channel=community"]);
});
