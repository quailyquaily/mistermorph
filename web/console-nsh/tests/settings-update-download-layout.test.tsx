// Where the Updates card's download buttons lie (SettingsUpdatePanel's `onPartLayout`): on phones
// they take the release box's whole width and a long label wraps inside the button; on wider
// screens a button keeps its own width and height beside the release notes, as before.
import { expect, test } from "nsh/test";
import { openFixture } from "./fixtures/integrations-harness";

type Frame = { x: number; y: number; w: number; h: number };

const AUTO_UPDATE = {
  auto_update: { enabled: false, channel: "community" },
  build_channel: "community",
  current_version: "0.9.0",
  config_revision: "r-1",
};
const RELEASE = { update_available: true, channel: "community", current_version: "0.9.0", latest_version: "1.0.0", release_notes: "- Faster startup" };
const SERVER_ASSET = { platform: "linux-amd64", asset_url: "https://downloads.example/MrMorph-linux-amd64.tar.gz", checksum: "sha256:" + "f".repeat(64) };
const MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", uaPlatform: "macOS", architecture: "arm", bitness: "64" };
const MAC_DOWNLOAD = { status: "available", os: "darwin", arch: "arm64", url: "https://downloads.example/MrMorph-darwin-arm64.tar.gz", checksum: "sha256:" + "b".repeat(64) };
const ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile", platform: "Linux armv8l", uaPlatform: "Android" };
const SM_HEIGHT = 38;

async function openChecked(width: number, client: Record<string, unknown>, download: Record<string, unknown>) {
  const fixture = await openFixture({
    view: "app",
    width,
    params: { probeUpdate: true },
    host: { "morph.client.platform": client },
    api: {
      "GET /settings/auto-update": { body: AUTO_UPDATE },
      "POST /settings/auto-update/check": { body: { ...RELEASE, ...SERVER_ASSET, download } },
    },
  });
  await fixture.app.waitFor("v0.9.0 · Community");
  await fixture.app.press("id:settings-update-check");
  await fixture.app.waitFor("v1.0.0 is available.");
  /** The last frame each part reported. */
  const frames = () => {
    const out: Record<string, Frame> = {};
    for (const event of fixture.eventsNamed("update.part")) out[event.data.name] = event.data.frame;
    return out;
  };
  return { ...fixture, frames };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

test("on a phone the download takes the release box's width", async () => {
  const { app, frames } = await openChecked(390, ANDROID, { status: "available", os: "android", url: "https://downloads.example/MrMorph-android.apk" });
  await app.waitUntil(() => Boolean(frames()["button:settings-update-download"] && frames().downloads && frames().release));
  const { release, downloads, "button:settings-update-download": button } = frames();
  expect(near(downloads.x, release.x) && near(downloads.w, release.w)).toBe(true);
  expect(near(button.x, release.x) && near(button.w, release.w)).toBe(true);
  expect(button.h).toBe(SM_HEIGHT);
  // Below the release notes, not beside them.
  expect(downloads.y).toBeGreaterThan(release.y + 20);
});

test("on a narrow phone a long label wraps inside the full-width button", async () => {
  const { app, frames } = await openChecked(320, MAC, MAC_DOWNLOAD);
  await app.waitFor("Download for macOS (Apple silicon)");
  await app.waitUntil(() => Boolean(frames()["button:settings-update-download"] && frames().release));
  const { release, "button:settings-update-download": button } = frames();
  expect(near(button.x, release.x) && near(button.w, release.w)).toBe(true);
  // Taller than one line: the label went onto a second line rather than past the button's edge.
  expect(button.h).toBeGreaterThan(SM_HEIGHT);
  expect(button.x + button.w).toBeLessThanOrEqual(release.x + release.w + 1);
});

test("on a phone each build to pick and the releases button take the full width", async () => {
  const choose = await openChecked(390, { userAgent: "Mozilla/5.0 (X11; Linux)", platform: "Linux" }, {
    status: "choose",
    os: "linux",
    options: [
      { os: "linux", arch: "amd64", url: "https://downloads.example/a.tar.gz" },
      { os: "linux", arch: "arm64", url: "https://downloads.example/b.tar.gz" },
    ],
  });
  const ids = ["button:settings-update-download-linux-amd64", "button:settings-update-download-linux-arm64"];
  await choose.app.waitUntil(() => ids.every((id) => choose.frames()[id]) && Boolean(choose.frames().release));
  const { release } = choose.frames();
  for (const id of ids) {
    const button = choose.frames()[id];
    expect({ id, full: near(button.x, release.x) && near(button.w, release.w) }).toEqual({ id, full: true });
  }

  const none = await openChecked(390, ANDROID, { status: "unavailable", reason: "not_published", os: "android" });
  await none.app.waitUntil(() => Boolean(none.frames()["button:settings-update-open-releases"] && none.frames().release));
  const button = none.frames()["button:settings-update-open-releases"];
  expect(near(button.x, none.frames().release.x) && near(button.w, none.frames().release.w)).toBe(true);
});

test("on a desktop screen the download keeps its own size beside the release notes", async () => {
  const { app, frames } = await openChecked(1280, MAC, MAC_DOWNLOAD);
  await app.waitUntil(() => Boolean(frames()["button:settings-update-download"] && frames().release));
  const { release, "button:settings-update-download": button } = frames();
  expect(button.h).toBe(SM_HEIGHT);
  expect(button.w).toBeLessThan(release.w / 2);
  // At the right of the notes column, on its first line.
  expect(button.x).toBeGreaterThan(release.x + release.w / 2);
  expect(button.y).toBeLessThan(release.y + 20);
});
