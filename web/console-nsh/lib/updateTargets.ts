// The two things the Updates card (Settings › System) reports on, each from its own source:
//
// - the shell: the installed native app the Console runs in (the desktop app, the Android app, the
//   iOS app). Its version comes from the host (lib/platform.ts `shellInfo`); a browser has no shell.
// - the server: the console server the Console is connected to. Its version comes from that
//   server's `GET /settings/auto-update`.
//
// Neither ever stands in for the other: a shell whose host cannot tell its version is "unknown",
// never the server's version, and a shell update check never reads the server's own result.

/** Which installed app the Console runs in. */
export type ShellKind = "desktop" | "android" | "ios";

/** The shell as its host reports it; `version` and `build` are "" when the host cannot tell. */
export interface ShellInfo {
  kind: ShellKind;
  version: string;
  build: string;
}

/** What the host's boot data says of the shell (lib/platform.ts `Boot`). */
export interface ShellBoot {
  runtime: "web" | "desktop" | "mobile";
  /** `platform.os` of nsh. */
  os: string;
  /** The shell the host reports (the phone app's native part), if any. */
  shell?: { version?: unknown; build?: unknown } | null;
  /** The desktop app's version: the desktop host's older name for its shell's version. */
  desktopVersion?: unknown;
}

const text = (value: unknown) => String(value ?? "").trim();

/** The shell the Console runs in, or null in a browser (which is no shell of ours). */
export function shellFromBoot(boot: ShellBoot): ShellInfo | null {
  if (boot.runtime === "web") return null;
  if (boot.runtime === "desktop") {
    return { kind: "desktop", version: text(boot.shell?.version) || text(boot.desktopVersion), build: text(boot.shell?.build) };
  }
  const kind: ShellKind = String(boot.os || "").toLowerCase() === "ios" ? "ios" : "android";
  return { kind, version: text(boot.shell?.version), build: text(boot.shell?.build) };
}

/**
 * How the shell's updates are checked:
 * - `native`: the shell checks for itself (the desktop app's `morph.desktop.checkUpdate`);
 * - `release`: the release's file for this system is looked up (the server's check with
 *   `download_os`, which reads the release feed) and its version compared with the installed one
 *   here (the Android app, whose updates are the release's APK);
 * - `unavailable`: no check; `reason` says why (`unknown_version`: the host did not tell the
 *   installed version, so nothing can be compared; `unsupported`: this shell has no update check).
 */
export type ShellCheck = { mode: "native" } | { mode: "release"; os: string } | { mode: "unavailable"; reason: "unknown_version" | "unsupported" };

export function shellCheck(shell: ShellInfo, features: { checkUpdate: boolean }): ShellCheck {
  if (shell.kind === "desktop") return features.checkUpdate ? { mode: "native" } : { mode: "unavailable", reason: "unsupported" };
  // No iOS app is published, and nsh has no store lookup: nothing to check against.
  if (shell.kind === "ios") return { mode: "unavailable", reason: "unsupported" };
  if (!shell.version) return { mode: "unavailable", reason: "unknown_version" };
  return { mode: "release", os: "android" };
}

/* ---------- versions ---------- */

interface ParsedVersion {
  parts: number[];
  pre: string;
}

// internal/updatecheck's parseVersion: `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build`; `dev` is none.
function parseVersion(raw: unknown): ParsedVersion | null {
  let version = text(raw).replace(/^v/, "");
  if (!version || version.toLowerCase() === "dev") return null;
  version = version.split("+")[0];
  const dash = version.indexOf("-");
  const core = dash < 0 ? version : version.slice(0, dash);
  const pre = dash < 0 ? "" : version.slice(dash + 1);
  const parts: number[] = [];
  for (const segment of core.split(".")) {
    if (!/^\d+$/.test(segment)) return null;
    parts.push(Number(segment));
  }
  return parts.length ? { parts, pre } : null;
}

/** -1, 0 or 1 as `current` is older, the same or newer than `latest`; null when either is no version. */
export function compareVersions(current: unknown, latest: unknown): number | null {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const av = a.parts[i] ?? 0;
    const bv = b.parts[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * A release lookup's answer (`POST /settings/auto-update/check`) as the installed shell's check:
 * its own `update_available` and `current_version` are the server's, so they are replaced by the
 * installed shell's version against the release's. A version that cannot be compared (a
 * development build) is `current_version_unknown`. A channel switch is the server's, not the
 * shell's, and is dropped, as are the server's own file (`platform`, `asset_url`, `checksum`): only
 * the answer's `download`, the release's file for the shell's system, is the shell's.
 */
export function shellReleaseAnswer<T extends Record<string, any>>(installed: string, answer: T | null | undefined): T {
  const order = compareVersions(installed, answer?.latest_version);
  return {
    ...(answer || ({} as T)),
    current_version: installed,
    current_channel: "",
    channel_switch: false,
    update_available: order !== null && order < 0,
    status: order === null ? "current_version_unknown" : order < 0 ? "update_available" : "up_to_date",
    platform: "",
    asset_url: "",
    checksum: "",
  };
}
