// The gallery's colours (/__ui-components): every token of the console's colour scheme (theme.json),
// in sections by what it is for, each with its value in the light and the dark palette. The page
// draws a swatch per token in the appearance shown, and the tints (./colorRules.js).
import theme from "../../theme.json";
import { NSH_NAMES, TINT_HUES, TINT_STEPS } from "./colorRules.js";

export { NSH_NAMES, TINT_HUES, TINT_STEPS };

const VARS = (theme as { cssVars: { light: Record<string, string>; dark: Record<string, string> } }).cssVars;

export type ColorSchemeName = "light" | "dark";
export interface ColorToken {
  name: string;
  light: string;
  dark: string;
}
export interface ColorSection {
  id: string;
  /** Its title's key in lib/i18n. */
  titleKey: string;
  tokens: ColorToken[];
}

/** What a token is for, by its name: the first section whose test it passes. */
const SECTIONS: { id: string; test: (name: string) => boolean }[] = [
  { id: "chart", test: (name) => name.startsWith("chart-") },
  { id: "status", test: (name) => /^(ok|info|danger|warn|destructive|close|status)(-|$)/.test(name) && !name.endsWith("foreground") },
  { id: "accent", test: (name) => /^(primary|blue|ink|ring|accent)(-|$)/.test(name) && !name.endsWith("foreground") },
  { id: "text", test: (name) => /(^|-)foreground$|^(subtle|placeholder|on-accent)$|text$/.test(name) },
  { id: "line", test: (name) => /^(border|input|line|selection|hover|press|outline|scrim|sheen)(-|$)/.test(name) },
  { id: "surface", test: () => true },
];
/** The sections in the order the page shows them. */
const ORDER = ["surface", "text", "accent", "status", "line", "chart"];

/** The scheme's tokens by section; a token that only one palette has is left out (the palettes share their names). */
export const COLOR_SECTIONS: ColorSection[] = ORDER.map((id) => ({
  id,
  titleKey: `uig_colors_${id}`,
  tokens: Object.keys(VARS.light)
    .filter((name) => name in VARS.dark && SECTIONS.find((section) => section.test(name))?.id === id)
    .map((name) => ({ name, light: VARS.light[name], dark: VARS.dark[name] })),
})).filter((section) => section.tokens.length > 0);

export const COLOR_TOKENS: ColorToken[] = COLOR_SECTIONS.flatMap((section) => section.tokens);
