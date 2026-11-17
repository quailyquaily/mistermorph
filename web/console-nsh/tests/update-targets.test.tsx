// The Updates card's two targets (lib/updateTargets.ts): which shell the Console runs in and its
// version from the host alone, how that shell's updates are checked, and a release lookup read as
// the installed shell's check rather than the server's.
import { expect, test } from "nsh/test";
import { compareVersions, shellCheck, shellFromBoot, shellReleaseAnswer } from "../lib/updateTargets";

test("a browser has no shell; the desktop and phone apps are theirs, with the host's version only", () => {
  expect(shellFromBoot({ runtime: "web", os: "web", desktopVersion: "" })).toBe(null);
  // Even a web host that reported something is no shell.
  expect(shellFromBoot({ runtime: "web", os: "linux", shell: { version: "1.0.0" } })).toBe(null);
  expect(shellFromBoot({ runtime: "desktop", os: "linux", desktopVersion: "1.2.3" })).toEqual({ kind: "desktop", version: "1.2.3", build: "" });
  // A host's `shell` wins over the older `desktopVersion`.
  expect(shellFromBoot({ runtime: "desktop", os: "macos", desktopVersion: "1.2.3", shell: { version: " 1.4.0 ", build: 7 } })).toEqual({
    kind: "desktop",
    version: "1.4.0",
    build: "7",
  });
  expect(shellFromBoot({ runtime: "mobile", os: "android", shell: { version: "0.3.80", build: "3080" } })).toEqual({ kind: "android", version: "0.3.80", build: "3080" });
  // Without the native part's answer the version is unknown: "".
  expect(shellFromBoot({ runtime: "mobile", os: "android", shell: null, desktopVersion: "" })).toEqual({ kind: "android", version: "", build: "" });
  expect(shellFromBoot({ runtime: "mobile", os: "ios" })).toEqual({ kind: "ios", version: "", build: "" });
});

test("each shell's update check, or why there is none", () => {
  const desktop = { kind: "desktop", version: "1.2.3", build: "" } as const;
  expect(shellCheck(desktop, { checkUpdate: true })).toEqual({ mode: "native" });
  expect(shellCheck(desktop, { checkUpdate: false })).toEqual({ mode: "unavailable", reason: "unsupported" });
  expect(shellCheck({ kind: "android", version: "0.3.80", build: "3080" }, { checkUpdate: false })).toEqual({ mode: "release", os: "android" });
  expect(shellCheck({ kind: "android", version: "", build: "" }, { checkUpdate: false })).toEqual({ mode: "unavailable", reason: "unknown_version" });
  expect(shellCheck({ kind: "ios", version: "1.0.0", build: "1" }, { checkUpdate: true })).toEqual({ mode: "unavailable", reason: "unsupported" });
});

test("versions compare as the server's update check compares them", () => {
  expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  expect(compareVersions("dev", "1.0.0")).toBe(null);
  expect(compareVersions("", "1.0.0")).toBe(null);
  expect(compareVersions("1.0.0", "")).toBe(null);
});

test("a release lookup becomes the installed shell's answer, never the server's", () => {
  const server = {
    status: "update_available",
    update_available: true,
    channel: "community",
    current_channel: "pro",
    channel_switch: true,
    current_version: "0.9.0",
    latest_version: "1.0.0",
    platform: "linux-amd64",
    asset_url: "https://downloads.example/MrMorph-linux-amd64.tar.gz",
    checksum: "sha256:server",
    download: { status: "available", os: "android", url: "https://downloads.example/MrMorph-android.apk" },
  };
  const current = shellReleaseAnswer("1.0.0", server);
  expect(current.update_available).toBe(false);
  expect(current.status).toBe("up_to_date");
  expect(current.current_version).toBe("1.0.0");
  expect(current.channel_switch).toBe(false);
  // The server's own file is dropped; the release's file for the shell's system stays.
  expect(current.asset_url).toBe("");
  expect(current.checksum).toBe("");
  expect(current.platform).toBe("");
  expect(current.download).toEqual(server.download);
  expect(current.latest_version).toBe("1.0.0");

  const older = shellReleaseAnswer("0.8.0", { ...server, update_available: false, status: "up_to_date" });
  expect(older.update_available).toBe(true);
  expect(older.status).toBe("update_available");

  const dev = shellReleaseAnswer("dev", server);
  expect(dev.update_available).toBe(false);
  expect(dev.status).toBe("current_version_unknown");
});
