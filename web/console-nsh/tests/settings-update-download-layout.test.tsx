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
  await fixture.app.press("id:settings-update-server-check");
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

// A download is an icon button with the file's name as plain text beside it: the row takes the
// width, the button is a square at its end.
const square = (button: { w: number; h: number }) => button.w === SM_HEIGHT && button.h === SM_HEIGHT;

test("on a phone the download's row takes the release box's width, the icon button at its end", async () => {
  const { app, frames } = await openChecked(390, ANDROID, { status: "available", os: "android", url: "https://downloads.example/MrMorph-android.apk" });
  await app.waitUntil(() => Boolean(frames()["button:settings-update-server-download"] && frames()["button:settings-update-server-download-row"] && frames()["server.downloads"] && frames()["server.release"]));
  const { "server.release": release, "server.downloads": downloads, "button:settings-update-server-download": button, "button:settings-update-server-download-row": row } = frames();
  expect(near(downloads.x, release.x) && near(downloads.w, release.w)).toBe(true);
  expect(near(row.x, release.x) && near(row.w, release.w)).toBe(true);
  // The button is a square at the row's end.
  expect(square(button)).toBe(true);
  expect(near(button.x + button.w, row.x + row.w)).toBe(true);
  // Its name is not on it: it is the text beside it, once, and the button's accessible name.
  expect(app.texts().filter((text) => text === "Download for Android")).toHaveLength(1);
  expect(app.shows("id:settings-update-server-download-label")).toBe(true);
  expect(app.count("label:Download for Android")).toBe(1);
  // Below the release notes, not beside them.
  expect(downloads.y).toBeGreaterThan(release.y + 20);
});

test("on a narrow phone a long name wraps beside the icon button, inside the row", async () => {
  const { app, frames } = await openChecked(320, MAC, MAC_DOWNLOAD);
  await app.waitFor("Download for macOS (Apple silicon)");
  await app.waitUntil(() => Boolean(frames()["button:settings-update-server-download"] && frames()["button:settings-update-server-download-row"] && frames()["server.release"]));
  const { "server.release": release, "button:settings-update-server-download": button, "button:settings-update-server-download-row": row } = frames();
  expect(near(row.x, release.x) && near(row.w, release.w)).toBe(true);
  // The name has the row's width less the button, and wraps there if it must: the button stays a
  // square at the row's end, inside the box.
  expect(square(button)).toBe(true);
  expect(row.h).toBeGreaterThanOrEqual(SM_HEIGHT);
  expect(near(button.x + button.w, row.x + row.w)).toBe(true);
  expect(button.x + button.w).toBeLessThanOrEqual(release.x + release.w + 1);
});

test("on a phone each build to pick is a full-width row, told apart by its text; the releases button is a square icon button", async () => {
  const choose = await openChecked(390, { userAgent: "Mozilla/5.0 (X11; Linux)", platform: "Linux" }, {
    status: "choose",
    os: "linux",
    options: [
      { os: "linux", arch: "amd64", url: "https://downloads.example/a.tar.gz" },
      { os: "linux", arch: "arm64", url: "https://downloads.example/b.tar.gz" },
    ],
  });
  const ids = ["button:settings-update-server-download-linux-amd64", "button:settings-update-server-download-linux-arm64"];
  await choose.app.waitUntil(() => ids.every((id) => choose.frames()[id]) && Boolean(choose.frames()["server.release"]));
  const { "server.release": release } = choose.frames();
  await choose.app.waitUntil(() => ids.every((id) => choose.frames()[`${id}-row`]));
  for (const id of ids) {
    const row = choose.frames()[`${id}-row`];
    expect({ id, full: near(row.x, release.x) && near(row.w, release.w), square: square(choose.frames()[id]) }).toEqual({ id, full: true, square: true });
  }
  // Each build's name is text beside its button, and the button's own name.
  for (const id of ids) expect(choose.app.shows(`id:${id.slice("button:".length)}-label`)).toBe(true);
  const names = choose.app.texts().filter((text) => text.startsWith("Download for "));
  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);
  for (const name of names) expect(choose.app.count(`label:${name}`)).toBe(1);

  const none = await openChecked(390, ANDROID, { status: "unavailable", reason: "not_published", os: "android" });
  await none.app.waitUntil(() => Boolean(none.frames()["button:settings-update-server-open-releases"] && none.frames()["server.release"]));
  // An icon button (the arrow, named "Open releases"): square, at the start, its label not drawn.
  const button = none.frames()["button:settings-update-server-open-releases"];
  expect(near(button.x, none.frames()["server.release"].x)).toBe(true);
  expect({ w: button.w, h: button.h }).toEqual({ w: SM_HEIGHT, h: SM_HEIGHT });
  expect(none.app.texts()).not.toContain("Open releases");
  expect(none.app.count("label:Open releases")).toBe(1);
});

test("on a desktop screen the download keeps its own size beside the release notes", async () => {
  const { app, frames } = await openChecked(1280, MAC, MAC_DOWNLOAD);
  await app.waitUntil(() => Boolean(frames()["button:settings-update-server-download"] && frames()["server.release"]));
  const { "server.release": release, "button:settings-update-server-download": button } = frames();
  await app.waitUntil(() => Boolean(frames()["button:settings-update-server-download-row"]));
  const row = frames()["button:settings-update-server-download-row"];
  expect(square(button)).toBe(true);
  expect(row.w).toBeLessThan(release.w / 2);
  // At the right of the notes column, on its first line.
  expect(row.x).toBeGreaterThan(release.x + release.w / 2);
  expect(row.y).toBeLessThan(release.y + 20);
});
