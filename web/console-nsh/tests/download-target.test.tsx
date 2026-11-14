// The Updates card's download target (lib/downloadTarget.ts) and what the web host reads from the
// browser for it (host.js `clientPlatform`): the device's own system, Android before Linux, an
// architecture only where the browser tells it, and never the server's file for another system.
import { expect, test } from "nsh/test";
import { clientPlatform } from "../host.js";
import { browserTarget, downloadChoice, downloadQuery, nativeTarget, platformKey, systemName } from "../lib/downloadTarget";

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0",
  chromeOS: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};

test("a browser's system: Android before Linux, an architecture only where the browser tells it", () => {
  const cases: [string, Parameters<typeof browserTarget>[0], { os: string; arch: string }][] = [
    // Android's browsers say Linux too (`Linux armv8l`); the phone is Android, whatever the server runs.
    ["Android Chrome", { userAgent: UA.androidChrome, platform: "Linux armv8l", uaPlatform: "Android", architecture: "arm", bitness: "64" }, { os: "android", arch: "" }],
    ["Android Firefox", { userAgent: UA.androidFirefox, platform: "Linux aarch64" }, { os: "android", arch: "" }],
    ["iPhone", { userAgent: UA.iphone, platform: "iPhone", maxTouchPoints: 5 }, { os: "ios", arch: "" }],
    ["iPad as a desktop site", { userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 }, { os: "ios", arch: "" }],
    // Safari says Intel on every Mac: the architecture stays unknown.
    ["Mac Safari", { userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 }, { os: "darwin", arch: "" }],
    ["Mac Chrome with client hints", { userAgent: UA.macSafari, platform: "MacIntel", uaPlatform: "macOS", architecture: "arm", bitness: "64" }, { os: "darwin", arch: "arm64" }],
    ["Intel Mac Chrome", { userAgent: UA.macSafari, platform: "MacIntel", uaPlatform: "macOS", architecture: "x86", bitness: "64" }, { os: "darwin", arch: "amd64" }],
    // Windows says x64 whatever the processor; only client hints tell.
    ["Windows without hints", { userAgent: UA.windows, platform: "Win32" }, { os: "windows", arch: "" }],
    ["Windows on ARM with hints", { userAgent: UA.windows, platform: "Win32", uaPlatform: "Windows", architecture: "arm", bitness: "64" }, { os: "windows", arch: "arm64" }],
    ["Linux x86_64", { userAgent: UA.linux, platform: "Linux x86_64" }, { os: "linux", arch: "amd64" }],
    ["Linux aarch64", { userAgent: UA.linuxArm, platform: "Linux aarch64" }, { os: "linux", arch: "arm64" }],
    ["Linux of unknown machine", { userAgent: "Mozilla/5.0 (X11; Linux)", platform: "Linux" }, { os: "linux", arch: "" }],
    ["ChromeOS", { userAgent: UA.chromeOS, platform: "Linux x86_64", uaPlatform: "Chrome OS" }, { os: "", arch: "" }],
    ["nothing", {}, { os: "", arch: "" }],
  ];
  for (const [name, info, want] of cases) {
    expect({ name, target: browserTarget(info) }).toEqual({ name, target: want });
  }
  expect(browserTarget(null)).toEqual({ os: "", arch: "" });
});

test("a native app's system is nsh's OS, without an architecture", () => {
  expect(nativeTarget("android")).toEqual({ os: "android", arch: "" });
  expect(nativeTarget("ios")).toEqual({ os: "ios", arch: "" });
  expect(nativeTarget("macos")).toEqual({ os: "darwin", arch: "" });
  expect(nativeTarget("linux")).toEqual({ os: "linux", arch: "" });
  expect(nativeTarget("windows")).toEqual({ os: "windows", arch: "" });
  expect(nativeTarget("web")).toEqual({ os: "", arch: "" });
});

test("the check's query and the system names", () => {
  expect(downloadQuery({ os: "android", arch: "" })).toBe("download_os=android");
  expect(downloadQuery({ os: "linux", arch: "arm64" })).toBe("download_os=linux&download_arch=arm64");
  expect(downloadQuery({ os: "", arch: "" })).toBe("download_os=");
  expect(platformKey({ os: "darwin", arch: "arm64" })).toBe("macos-arm64");
  expect(platformKey({ os: "linux", arch: "" })).toBe("");
  expect(systemName("android", "")).toBe("Android");
  expect(systemName("darwin", "arm64")).toBe("macOS (Apple silicon)");
  expect(systemName("linux", "amd64")).toBe("Linux (x86-64)");
  expect(systemName("windows", "arm64")).toBe("Windows (ARM64)");
  expect(systemName("", "amd64")).toBe("");
});

const SERVER_LINUX = {
  platform: "linux-amd64",
  asset_url: "https://dl.example/MrMorph-linux-amd64.tar.gz",
  checksum: "sha256:server",
};

test("the answer's download: the device's file, choices, or why there is none", () => {
  const apk = { status: "available", os: "android", url: "https://dl.example/MrMorph-android.apk", checksum: "sha256:apk" };
  // A Linux server asked from an Android phone: the APK, with its own checksum.
  expect(downloadChoice({ ...SERVER_LINUX, download: apk }, { os: "android", arch: "" }, false)).toEqual({
    kind: "file",
    file: { os: "android", arch: "", url: apk.url, checksum: "sha256:apk" },
  });
  const options = [
    { os: "linux", arch: "amd64", url: "https://dl.example/a.tar.gz", checksum: "sha256:a" },
    { os: "linux", arch: "arm64", url: "https://dl.example/b.tar.gz" },
  ];
  expect(downloadChoice({ download: { status: "choose", os: "linux", options } }, { os: "linux", arch: "" }, false)).toEqual({
    kind: "choose",
    files: [
      { os: "linux", arch: "amd64", url: "https://dl.example/a.tar.gz", checksum: "sha256:a" },
      { os: "linux", arch: "arm64", url: "https://dl.example/b.tar.gz", checksum: "" },
    ],
  });
  for (const reason of ["unknown_platform", "not_published", "unreachable"]) {
    expect(downloadChoice({ ...SERVER_LINUX, download: { status: "unavailable", reason } }, { os: "android", arch: "" }, false)).toEqual({ kind: "none", reason });
  }
  // A malformed "available" without a URL is not a download.
  expect(downloadChoice({ ...SERVER_LINUX, download: { status: "available" } }, { os: "android", arch: "" }, false)).toEqual({ kind: "none", reason: "not_published" });
});

test("an older server without a download: its file only when it is exactly the device's platform", () => {
  // Never Android => Linux.
  expect(downloadChoice(SERVER_LINUX, { os: "android", arch: "" }, false)).toEqual({ kind: "none", reason: "pick" });
  // A Linux browser of unknown architecture cannot tell the server's file is its own.
  expect(downloadChoice(SERVER_LINUX, { os: "linux", arch: "" }, false)).toEqual({ kind: "none", reason: "pick" });
  expect(downloadChoice(SERVER_LINUX, { os: "linux", arch: "arm64" }, false)).toEqual({ kind: "none", reason: "pick" });
  expect(downloadChoice(SERVER_LINUX, { os: "linux", arch: "amd64" }, false)).toEqual({
    kind: "file",
    file: { os: "linux", arch: "amd64", url: SERVER_LINUX.asset_url, checksum: "sha256:server" },
  });
  expect(downloadChoice(null, { os: "linux", arch: "amd64" }, false)).toEqual({ kind: "none", reason: "pick" });
});

test("the desktop app's own check offers its own file", () => {
  expect(downloadChoice({ ...SERVER_LINUX, download: { status: "unavailable" } }, { os: "", arch: "" }, true)).toEqual({
    kind: "file",
    file: { os: "", arch: "", url: SERVER_LINUX.asset_url, checksum: "sha256:server" },
  });
  expect(downloadChoice({ latest_version: "1.0.0" }, { os: "", arch: "" }, true)).toEqual({ kind: "none", reason: "not_published" });
});

test("host.js reads the browser's platform and asks for its processor where it can", async () => {
  const asked: string[][] = [];
  const chrome = {
    userAgent: UA.windows,
    platform: "Win32",
    maxTouchPoints: 0,
    userAgentData: {
      platform: "Windows",
      getHighEntropyValues: async (hints: string[]) => {
        asked.push(hints);
        return { architecture: "arm", bitness: "64", platform: "Windows" };
      },
    },
  };
  expect(await clientPlatform(chrome)).toEqual({
    userAgent: UA.windows,
    platform: "Win32",
    uaPlatform: "Windows",
    maxTouchPoints: 0,
    architecture: "arm",
    bitness: "64",
  });
  expect(asked).toEqual([["architecture", "bitness"]]);

  const refusing = { ...chrome, userAgentData: { platform: "Windows", getHighEntropyValues: async () => Promise.reject(new Error("denied")) } };
  expect((await clientPlatform(refusing)).architecture).toBe("");

  // Firefox and Safari have no client hints.
  expect(await clientPlatform({ userAgent: UA.linux, platform: "Linux x86_64" })).toEqual({
    userAgent: UA.linux,
    platform: "Linux x86_64",
    uaPlatform: "",
    maxTouchPoints: 0,
    architecture: "",
    bitness: "",
  });
  expect(browserTarget(await clientPlatform(chrome))).toEqual({ os: "windows", arch: "arm64" });
});
