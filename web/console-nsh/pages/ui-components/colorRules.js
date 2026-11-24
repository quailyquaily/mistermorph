// The colour scheme's rules that the code keeps and the gallery shows (/ui-components, Colors):
// - the tints: a colour's fill or border at a share (`bg-blue/10`, `border-danger/45`) takes one
//   of a few steps, whatever the colour, so the same state looks the same on every page;
// - nsh's names: keys of theme.json that nsh's own components read (shadcn's names), each the
//   same colour as one of the console's tokens; the console's code uses its own name.
// scripts/color-steps.test.mjs checks the sources against both.

/** The colours whose shares keep to the steps; the neutral tokens keep their own. */
export const TINT_HUES = ["blue", "primary", "info", "ok", "warn", "danger"];

/** The steps, in percent, each with what it is for (its label's key in lib/i18n). */
export const TINT_STEPS = {
  bg: [
    { share: 4, role: "uig_tint_wash" },
    { share: 6, role: "uig_tint_hover" },
    { share: 10, role: "uig_tint_pressed" },
    { share: 12, role: "uig_tint_chip" },
    { share: 18, role: "uig_tint_tint_hover" },
    { share: 22, role: "uig_tint_selection" },
  ],
  border: [
    { share: 35, role: "uig_tint_quiet" },
    { share: 45, role: "uig_tint_rest" },
    { share: 60, role: "uig_tint_strong" },
  ],
};

/** nsh's name → the console's token of the same colour, which the console's code uses. */
export const NSH_NAMES = {
  background: "paper",
  border: "line",
  destructive: "danger",
  "card-foreground": "foreground",
  "popover-foreground": "foreground",
  "secondary-foreground": "foreground",
  "accent-foreground": "foreground",
  "sidebar-foreground": "foreground",
};
