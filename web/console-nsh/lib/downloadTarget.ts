// Which file the Updates card's Download button offers: the one for the machine the Console runs
// on (the phone app, a browser), never the console server's own. The server answers a check with a
// `download` for the system named here (internal/updatecheck/download.go); this file names the
// system and turns the answer into what the card shows.
//
// Names are Go's (GOOS/GOARCH): `android`, `ios`, `darwin`, `linux`, `windows`; `amd64`, `arm64`,
// `arm`, `386`. An empty `os` or `arch` means it cannot be told, and the card asks or links to the
// releases page rather than guessing.

export interface DownloadTarget {
  os: string;
  arch: string;
}

export const UNKNOWN_TARGET: DownloadTarget = { os: "", arch: "" };

/** What the web host reads from the browser (host.js `clientPlatform`). */
export interface BrowserInfo {
  userAgent?: string;
  /** `navigator.platform`. */
  platform?: string;
  /** `navigator.userAgentData.platform` (Chromium). */
  uaPlatform?: string;
  maxTouchPoints?: number;
  /** User-agent client hints (Chromium): `"x86"`/`"arm"` and `"64"`/`"32"`. */
  architecture?: string;
  bitness?: string;
}

/** The system of a native app: nsh's `platform.os`. The architecture is not reported. */
export function nativeTarget(os: string): DownloadTarget {
  switch (String(os || "").toLowerCase()) {
    case "android":
      return { os: "android", arch: "" };
    case "ios":
      return { os: "ios", arch: "" };
    case "macos":
      return { os: "darwin", arch: "" };
    case "linux":
      return { os: "linux", arch: "" };
    case "windows":
      return { os: "windows", arch: "" };
    default:
      return UNKNOWN_TARGET;
  }
}

function browserOS(info: BrowserInfo) {
  const hint = String(info.uaPlatform || "").trim().toLowerCase();
  const ua = String(info.userAgent || "");
  const platform = String(info.platform || "");
  // Android first: its browsers say "Linux" too.
  if (hint === "android" || /Android/i.test(ua)) return "android";
  if (hint === "ios" || /iPhone|iPad|iPod/i.test(ua) || /^(iPhone|iPad|iPod)/i.test(platform)) return "ios";
  // An iPad asks for the desktop site as a Mac with a touch screen.
  if (/^Mac/i.test(platform) && Number(info.maxTouchPoints || 0) > 1 && !hint) return "ios";
  if (hint === "macos" || /^Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) return "darwin";
  if (hint === "windows" || /^Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  if (hint === "chrome os" || hint === "chromeos" || /CrOS/i.test(ua)) return "";
  if (hint === "linux" || /Linux/i.test(platform) || /Linux|X11/i.test(ua)) return "linux";
  return "";
}

function browserArch(os: string, info: BrowserInfo) {
  if (os !== "darwin" && os !== "linux" && os !== "windows") return "";
  const architecture = String(info.architecture || "").trim().toLowerCase();
  const bitness = String(info.bitness || "").trim();
  if (architecture === "x86") return bitness === "64" ? "amd64" : bitness === "32" ? "386" : "";
  if (architecture === "arm") return bitness === "64" ? "arm64" : bitness === "32" ? "arm" : "";
  // Without client hints only Linux browsers tell their machine (`navigator.platform`); a Mac's
  // and Windows' user agents name Intel / x64 whatever the processor.
  if (os !== "linux") return "";
  const machine = String(info.platform || "").trim().split(/\s+/)[1]?.toLowerCase() || "";
  if (machine === "x86_64" || machine === "amd64") return "amd64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  if (/^armv[67]/.test(machine)) return "arm";
  if (/^i[3-6]86$/.test(machine)) return "386";
  return "";
}

/** The browser's system, and its architecture only where the browser tells it. */
export function browserTarget(info: BrowserInfo | null | undefined): DownloadTarget {
  if (!info) return UNKNOWN_TARGET;
  const os = browserOS(info);
  return { os, arch: os ? browserArch(os, info) : "" };
}

/** An update manifest key (`linux-amd64`, `macos-arm64`), or "" without an architecture. */
export function platformKey(target: DownloadTarget) {
  if (!target.os || !target.arch) return "";
  return `${target.os === "darwin" ? "macos" : target.os}-${target.arch}`;
}

/* ---------- the answer ---------- */

export interface DownloadFile {
  os: string;
  arch: string;
  url: string;
  checksum: string;
}

/**
 * What the card offers: one `file`, files to `choose` from, or `none` (with why: `unknown_platform`,
 * `not_published`, `unreachable`, or `pick` when an older server answered without a `download`).
 */
export type DownloadChoice =
  | { kind: "file"; file: DownloadFile }
  | { kind: "choose"; files: DownloadFile[] }
  | { kind: "none"; reason: string };

const text = (value: unknown) => String(value ?? "").trim();

function toFile(raw: any): DownloadFile | null {
  const url = text(raw?.url);
  return url ? { os: text(raw?.os), arch: text(raw?.arch), url, checksum: text(raw?.checksum) } : null;
}

/**
 * The download in a check's answer for `target`. `native`: the desktop app checked for itself, so
 * the answer's own asset is this machine's. Otherwise only the answer's `download` counts; from a
 * server without one, the asset is taken only when it is exactly the target's platform.
 */
export function downloadChoice(answer: any, target: DownloadTarget, native: boolean): DownloadChoice {
  if (!answer) return { kind: "none", reason: "pick" };
  if (native) {
    const url = text(answer.asset_url);
    return url ? { kind: "file", file: { os: "", arch: "", url, checksum: text(answer.checksum) } } : { kind: "none", reason: "not_published" };
  }
  const download = answer.download;
  if (download && typeof download === "object") {
    if (download.status === "available") {
      const file = toFile(download);
      if (file) return { kind: "file", file };
    }
    if (download.status === "choose") {
      const files = (Array.isArray(download.options) ? download.options : []).map(toFile).filter(Boolean) as DownloadFile[];
      if (files.length) return { kind: "choose", files };
    }
    return { kind: "none", reason: text(download.reason) || "not_published" };
  }
  const key = platformKey(target);
  const url = text(answer.asset_url);
  if (key && url && text(answer.platform) === key) {
    return { kind: "file", file: { os: target.os, arch: target.arch, url, checksum: text(answer.checksum) } };
  }
  return { kind: "none", reason: "pick" };
}

/** The query a check sends for `target`. */
export function downloadQuery(target: DownloadTarget) {
  const query = `download_os=${encodeURIComponent(target.os)}`;
  return target.arch ? `${query}&download_arch=${encodeURIComponent(target.arch)}` : query;
}

const OS_NAMES: Record<string, string> = { android: "Android", ios: "iOS", darwin: "macOS", linux: "Linux", windows: "Windows" };
const ARCH_NAMES: Record<string, string> = { amd64: "x86-64", arm64: "ARM64", arm: "ARM", "386": "x86" };

/** A system's name: `Linux (x86-64)`, `macOS (Apple silicon)`, `Android`; "" when unknown. */
export function systemName(os: string, arch: string, appleSilicon = "Apple silicon") {
  const name = OS_NAMES[os] || "";
  if (!name || !arch) return name;
  const archName = os === "darwin" && arch === "arm64" ? appleSilicon : ARCH_NAMES[arch] || arch;
  return `${name} (${archName})`;
}
