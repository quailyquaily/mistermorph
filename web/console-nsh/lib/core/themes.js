// The console's themes. Each one declares its own appearance (light or dark): there is no separate
// light/dark switch. Aojashin and Midnight are the palettes the app is built with (theme.json's
// `light` and `dark`); the others are given to nsh while the app runs (`setTheme`).
//
// A theme is its palette (the tokens of theme.json, all of them), what it overrides of the shared
// tokens (radii, fonts), and the few colours its preview is drawn from.
import builtin from "../../theme.json" with { type: "json" };

/** `hex` (#rrggbb) at `alpha` (two hex digits). */
const a = (hex, alpha) => `${hex.slice(0, 7)}${alpha}`;

/**
 * A palette from the colours a theme chooses: the surfaces, the inks, the accent, the status
 * colours and the main navigation's own. What theme.json writes out by hand for Aojashin (tints,
 * lines, the solid buttons' edges) is derived here the same way for every other theme.
 */
function palette(p) {
  const dark = p.scheme === "dark";
  const tint = p.tint;
  return {
    background: p.background,
    foreground: p.foreground,
    card: p.card,
    "card-foreground": p.foreground,
    popover: p.popover,
    "popover-foreground": p.foreground,
    primary: p.primary,
    "primary-foreground": p.primaryForeground,
    secondary: p.secondary,
    "secondary-foreground": p.foreground,
    muted: p.muted,
    "muted-foreground": p.mutedForeground,
    accent: a(tint, dark ? "0f" : "1a"),
    "accent-foreground": p.foreground,
    destructive: p.danger,
    border: a(tint, dark ? "29" : "3d"),
    input: a(tint, dark ? "1f" : "29"),
    ring: a(p.blue, dark ? "bf" : "9e"),
    sidebar: p.sidebar,
    "sidebar-foreground": p.foreground,
    nav: p.nav,
    subtle: p.subtle,
    ink: p.ink,
    blue: p.blue,
    "blue-light": p.blueLight,
    "blue-lighter": p.blueLighter,
    ok: p.ok,
    danger: p.danger,
    warn: p.warn,
    "warn-dark": p.warnDark,
    paper: p.background,
    float: p.float,
    field: dark ? "#ffffff0d" : "#ffffffeb",
    placeholder: p.placeholder,
    line: a(tint, dark ? "29" : "3d"),
    "line-soft": a(tint, dark ? "14" : "24"),
    "line-faint": a(tint, dark ? "0f" : "1f"),
    selection: a(p.selection, dark ? "33" : "1f"),
    hover: a(tint, dark ? "0f" : "12"),
    "hover-soft": a(tint, dark ? "0a" : "0d"),
    "selection-strong": a(p.selection, dark ? "4d" : "29"),
    segment: p.segment,
    press: dark ? "#ffffff14" : "#0000000d",
    "outline-bg": dark ? "#ffffff0d" : "#ffffffa3",
    "outline-bg-hover": dark ? "#ffffff17" : "#ffffffc7",
    "outline-line-hover": a(tint, dark ? "52" : "5c"),
    "primary-line": a(p.primaryPress, dark ? "d9" : "b3"),
    dialog: p.dialog,
    close: a(p.danger, dark ? "1f" : "1a"),
    "close-hover": a(p.danger, dark ? "33" : "29"),
    "status-off": a(p.mutedForeground, dark ? "99" : "b3"),
    "status-pending": p.pending,
    scrim: dark ? "#00000080" : a(p.foreground, "59"),
    "chart-1": p.charts[0],
    "chart-2": p.charts[1],
    "chart-3": p.charts[2],
    "chart-4": p.charts[3],
    "primary-hover": p.primaryHover,
    "on-accent": p.onAccent,
    info: p.info,
    sheen: dark ? "#ffffff14" : "#ffffffd9",
    "primary-press": p.primaryPress,
    "danger-hover": p.dangerHover,
    "danger-press": p.dangerPress,
    "danger-line": a(p.dangerPress, dark ? "d9" : "b3"),
    "warn-hover": p.warnHover,
    "warn-press": p.warnPress,
    "warn-line": a(p.warnPress, dark ? "d9" : "b3"),
    "solid-sheen": dark ? "#ffffff2e" : "#ffffff38",
    "solid-shadow": dark ? "#00000066" : a(p.shadow, "26"),
    "solid-shadow-hover": dark ? "#0000009e" : a(p.shadow, "3d"),
    mainnav: p.mainnav.fill,
    "mainnav-foreground": p.mainnav.foreground,
    "mainnav-subtle": p.mainnav.subtle,
    "mainnav-muted": p.mainnav.muted,
    "mainnav-icon": p.mainnav.icon,
    "mainnav-selection": p.mainnav.selection,
    "mainnav-hover": p.mainnav.hover,
    "mainnav-line": p.mainnav.line,
  };
}

// Midnight: navy and gold. theme.json's `dark` is this palette written out (themes.test.mjs
// checks they are the same).
const MIDNIGHT = palette({
  scheme: "dark",
  background: "#0f141c",
  card: "#151c27",
  popover: "#1a2230",
  dialog: "#19202c",
  secondary: "#151c27",
  muted: "#1c2433",
  segment: "#232d3e",
  sidebar: "#121822",
  nav: "#121822",
  float: "#131a24",
  foreground: "#e6e9ef",
  subtle: "#c9cfd9",
  mutedForeground: "#9aa3b2",
  placeholder: "#707b8d",
  ink: "#e0bc7a",
  blue: "#cfa35a",
  blueLight: "#b8914f",
  blueLighter: "#7d6438",
  primary: "#cfa35a",
  primaryForeground: "#1a1408",
  primaryHover: "#dab26c",
  primaryPress: "#b98f49",
  tint: "#ffffff",
  selection: "#cfa35a",
  ok: "#6fcf97",
  danger: "#f4a097",
  dangerHover: "#f7b1a9",
  dangerPress: "#e58b81",
  warn: "#f0c674",
  warnDark: "#f0c674",
  warnHover: "#f4d28f",
  warnPress: "#e2b560",
  info: "#9fc6ff",
  pending: "#f4e97a",
  onAccent: "#0f141c",
  charts: ["#cfa35a", "#f4a097", "#6fcf97", "#9fc6ff"],
  mainnav: {
    fill: "#121822",
    foreground: "#f3f5f8",
    subtle: "#c9cfd9",
    muted: "#9aa3b2",
    icon: "#cfa35a",
    selection: "#1c2433",
    hover: "#ffffff0a",
    line: "#222c3c",
  },
});

// Bunkō (分光): near-black with spectral cyan and pink; the filled button is white.
const BUNKO = palette({
  scheme: "dark",
  background: "#07080f",
  card: "#0e111d",
  popover: "#121629",
  dialog: "#10142a",
  secondary: "#0e111d",
  muted: "#151a30",
  segment: "#1c2342",
  sidebar: "#090b14",
  nav: "#05060b",
  float: "#0b0d18",
  foreground: "#f2f7ff",
  subtle: "#aeb6cc",
  mutedForeground: "#8e96b3",
  placeholder: "#69718f",
  ink: "#9ff3ff",
  blue: "#1fe5ff",
  blueLight: "#18b4c9",
  blueLighter: "#136f80",
  primary: "#f2f7ff",
  primaryForeground: "#07080f",
  primaryHover: "#ffffff",
  primaryPress: "#cfd8ea",
  tint: "#b4c0ff",
  selection: "#1fe5ff",
  ok: "#1fe5ff",
  danger: "#ff5fa5",
  dangerHover: "#ff7db6",
  dangerPress: "#ef4792",
  warn: "#ffc24d",
  warnDark: "#ffc24d",
  warnHover: "#ffd07a",
  warnPress: "#f0b23c",
  info: "#9fc6ff",
  pending: "#f4e97a",
  onAccent: "#07080f",
  charts: ["#1fe5ff", "#ff5fa5", "#ffc24d", "#9fc6ff"],
  mainnav: {
    fill: "#05060b",
    foreground: "#f2f7ff",
    subtle: "#aeb6cc",
    muted: "#8e96b3",
    icon: "#1fe5ff",
    selection: "#151a30",
    hover: "#ffffff0a",
    line: "#1c2342",
  },
});

// S.P.Q.R.: warm paper with a deep plum main navigation and gold marks on it.
const SPQR = palette({
  scheme: "light",
  background: "#fbf8f3",
  card: "#ffffff",
  popover: "#ffffff",
  dialog: "#ffffff",
  secondary: "#f4ecf2",
  muted: "#f1e8ee",
  segment: "#e7dce4",
  sidebar: "#fbf8f3",
  nav: "#f4ecf2",
  float: "#fdfbf8",
  foreground: "#221a20",
  subtle: "#3d3239",
  mutedForeground: "#675a63",
  placeholder: "#8d7f89",
  ink: "#3e1a3a",
  blue: "#6b2f64",
  blueLight: "#96608f",
  blueLighter: "#cdb3c9",
  primary: "#4a1f45",
  primaryForeground: "#ffffff",
  primaryHover: "#3e1a3a",
  primaryPress: "#2e1229",
  tint: "#4a1f45",
  selection: "#4a1f45",
  shadow: "#2e1229",
  ok: "#2e7d4f",
  danger: "#9e2b33",
  dangerHover: "#8b252c",
  dangerPress: "#781f26",
  warn: "#876019",
  warnDark: "#6e4e12",
  warnHover: "#775415",
  warnPress: "#664811",
  info: "#2f6fd0",
  pending: "#776b08",
  onAccent: "#ffffff",
  charts: ["#4a1f45", "#b5862a", "#2e7d4f", "#9e2b33"],
  mainnav: {
    fill: "#3e1a3a",
    foreground: "#ffffff",
    subtle: "#f3e9f0",
    muted: "#d4bfcf",
    icon: "#d9ac56",
    selection: "#2e1229",
    hover: "#ffffff12",
    line: "#d9ac5666",
  },
});

/** The theme a device has when it chose none. */
export const DEFAULT_THEME = "aojashin";

/**
 * The themes, in the order the Themes view shows them. `builtIn`: the palette is theme.json's own
 * for its appearance, so the app shows it as built. `preview`: the colours its small picture is
 * drawn from.
 */
export const THEMES = [
  {
    id: "aojashin",
    name: "Aojashin",
    scheme: "light",
    summaryKey: "settings_theme_summary_aojashin",
    builtIn: true,
    vars: builtin.cssVars.light,
  },
  {
    id: "spqr",
    name: "S.P.Q.R.",
    scheme: "light",
    summaryKey: "settings_theme_summary_spqr",
    builtIn: false,
    vars: SPQR,
    shared: { "radius-control": "6px", "radius-card": "8px", "radius-popover": "8px", "radius-dialog": "12px" },
  },
  {
    id: "midnight",
    name: "Midnight",
    scheme: "dark",
    summaryKey: "settings_theme_summary_midnight",
    builtIn: true,
    vars: MIDNIGHT,
  },
  {
    id: "bunko",
    name: "Bunkō",
    scheme: "dark",
    summaryKey: "settings_theme_summary_bunko",
    builtIn: false,
    vars: BUNKO,
  },
];

/** The theme `id` names; the default one for anything else. */
export function themeOf(id) {
  const key = String(id || "").trim().toLowerCase();
  return THEMES.find((theme) => theme.id === key) || THEMES[0];
}

/**
 * The theme a device shows: the one it chose, or, on a device that had only chosen the dark
 * appearance (before themes), the built-in dark theme.
 */
export function storedTheme(themeID, legacyScheme) {
  const key = String(themeID || "").trim().toLowerCase();
  if (THEMES.some((theme) => theme.id === key)) return key;
  return String(legacyScheme || "").trim().toLowerCase() === "dark" ? "midnight" : DEFAULT_THEME;
}

/**
 * What nsh takes for a theme (`setTheme`): null for a built-in one (the app's own theme.json in
 * that appearance), else the palette for both appearances, so it shows whichever the system has
 * until the theme's own is set.
 */
export function nshTheme(theme) {
  if (theme.builtIn) return null;
  return { cssVars: { theme: { ...builtin.cssVars.theme, ...(theme.shared || {}) }, light: theme.vars, dark: theme.vars } };
}

/** The colours a theme's small picture is drawn from. */
export function themePreview(theme) {
  const v = theme.vars;
  return {
    ground: v.background,
    panel: v.card,
    line: v.line,
    nav: v.mainnav,
    navSelection: v["mainnav-selection"],
    navText: v["mainnav-foreground"],
    navMuted: v["mainnav-muted"],
    mark: v["mainnav-icon"],
    ink: v.foreground,
    muted: v["muted-foreground"],
    accent: v.blue,
    bubble: v.muted,
    primary: v.primary,
  };
}

/** The page's own colours under the app for a theme, and the colour of the browser's chrome. */
export function themePageColors(theme) {
  return { background: theme.vars.nav, color: theme.vars.foreground };
}
