// The solid controls' finish (components/solidLook.ts): the filled Button variants (primary, danger,
// highlight), the filled CircleButtons and the capsule toolbar's primary share one look in three
// colours: a hairline a shade deeper than the fill, a lit top edge and a soft shadow at rest, a
// deeper shadow and a fill a step on hover, the shadow gone and the fill a step deeper pressed, an
// inset ring in the label's colour for the keyboard's focus. Disabled, loading and selected keep
// their own looks. Light and dark have their own values; the text keeps 4.5:1 on every enabled fill.
// Headless runs have no held press and no shadow query: the pressed fill and the shadows are
// checked on the classes and the helper's strings (and in Chrome, see the build's notes).
import { expect, open, test } from "nsh/test";
import theme from "../theme.json";
import { SOLID_FOCUS_RING, SOLID_HAIRLINE_COVER, SOLID_SHEEN, SOLID_TONES, solidBox, solidShadow, type SolidTone } from "../components/solidLook";
import { buttonVariantFinish, circleButtonClass, circleIconColor, DISABLED_OPACITY, type ButtonVariant } from "../components/ui";
import { CAPSULE_FOCUS_RING, capsuleButtonLook } from "../components/shared/CapsuleBar";

type Scheme = "light" | "dark";
const vars = (theme as { cssVars: Record<Scheme, Record<string, string>> }).cssVars;
const TONES: SolidTone[] = ["primary", "danger", "warn"];
const SCHEMES: Scheme[] = ["light", "dark"];
const classes = (value: string | undefined) => (value ?? "").split(/\s+/).filter(Boolean);

/* ---------- colour maths (WCAG 2) ---------- */

const rgba = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
};
/** `top` (may be translucent) laid over the opaque `under`, as `#rrggbb`. */
const over = (top: string, under: string) => {
  const [r, g, b, a] = rgba(top);
  const [R, G, B] = rgba(under);
  return `#${[r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgba(hex)
    .slice(0, 3)
    .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const color = (scheme: Scheme, name: string) => vars[scheme][name].toLowerCase();
/** A token as nsh reports a colour (`#rrggbbaa`). */
const reported = (scheme: Scheme, name: string) => {
  const value = color(scheme, name);
  return value.length === 7 ? `${value}ff` : value;
};

test("the text on every enabled solid fill keeps 4.5:1, at rest, on hover and pressed, in both palettes", () => {
  for (const scheme of SCHEMES) {
    for (const tone of TONES) {
      const t = SOLID_TONES[tone];
      const text = color(scheme, t.text);
      const fills = [t.fill, t.hover, t.press].map((name) => color(scheme, name));
      for (const [i, fill] of fills.entries()) {
        const ratio = contrast(text, fill);
        expect(`${scheme} ${tone} ${["rest", "hover", "pressed"][i]} ${ratio >= 4.5}`).toBe(`${scheme} ${tone} ${["rest", "hover", "pressed"][i]} true`);
      }
      // Three distinct fills.
      expect(new Set(fills).size).toBe(3);
    }
  }
});

test("hover takes a step (deeper on light, lighter on dark, where raised is lighter); pressed is deeper than rest on both", () => {
  for (const tone of TONES) {
    const t = SOLID_TONES[tone];
    for (const scheme of SCHEMES) {
      const [rest, hover, press] = [t.fill, t.hover, t.press].map((name) => luminance(color(scheme, name)));
      if (scheme === "light") expect(hover < rest && press < hover).toBe(true);
      else expect(hover > rest && press < rest).toBe(true);
    }
  }
});

test("the hairline is a shade deeper than the fill, the lit edge a shade lighter, and each palette has its own", () => {
  for (const scheme of SCHEMES) {
    for (const tone of TONES) {
      const t = SOLID_TONES[tone];
      const fill = color(scheme, t.fill);
      expect(luminance(over(color(scheme, t.line), fill))).toBeLessThan(luminance(fill));
      expect(luminance(over(color(scheme, "solid-sheen"), fill))).toBeGreaterThan(luminance(fill));
    }
  }
  // The shadow is the light palette's soft navy and the dark one's black, stronger (a faint shadow
  // does not show on near-black), deeper on hover in both.
  for (const name of ["solid-sheen", "solid-shadow", "solid-shadow-hover"]) expect(color("light", name)).not.toBe(color("dark", name));
  const alpha = (scheme: Scheme, name: string) => rgba(color(scheme, name))[3];
  expect(alpha("dark", "solid-shadow")).toBeGreaterThan(alpha("light", "solid-shadow"));
  for (const scheme of SCHEMES) expect(alpha(scheme, "solid-shadow-hover")).toBeGreaterThan(alpha(scheme, "solid-shadow"));
});

test("the focus ring is the label's colour, so it reads on every fill it is drawn over", () => {
  for (const scheme of SCHEMES) {
    for (const tone of TONES) {
      const t = SOLID_TONES[tone];
      for (const fill of [t.fill, t.hover]) expect(contrast(color(scheme, t.text), color(scheme, fill))).toBeGreaterThanOrEqual(3);
    }
  }
});

test("the finish by state: lit edge and soft shadow at rest, a deeper shadow on hover, none pressed, an inset ring on focus", () => {
  for (const scheme of SCHEMES) {
    const read = (name: string) => color(scheme, name);
    for (const tone of TONES) {
      const rest = solidShadow(tone, "rest", read as any);
      const hover = solidShadow(tone, "hover", read as any);
      const focus = solidShadow(tone, "focus", read as any);
      // The lit edge reaches one whole point past the hairline that covers its top.
      expect(rest).toBe(`inset 0 ${SOLID_HAIRLINE_COVER + SOLID_SHEEN}px 0 ${read("solid-sheen")}, 0 1px 2px ${read("solid-shadow")}`);
      expect(hover.startsWith(rest)).toBe(true);
      expect(hover).toContain(read("solid-shadow-hover"));
      expect(solidShadow(tone, "pressed", read as any)).toBe("none");
      expect(focus).toBe(`inset 0 0 0 ${SOLID_HAIRLINE_COVER + SOLID_FOCUS_RING}px ${read(SOLID_TONES[tone].text)}, 0 1px 2px ${read("solid-shadow")}`);
      // Whole points only, so they land on device pixels at 1x, 1.5x and 2x.
      for (const length of [...rest.matchAll(/inset[^,]*/g)].flatMap((m) => [...m[0].matchAll(/(\d+(?:\.\d+)?)px/g)].map((n) => Number(n[1]))))
        expect(Number.isInteger(length)).toBe(true);
      expect(Number.isInteger(SOLID_HAIRLINE_COVER + SOLID_FOCUS_RING)).toBe(true);
      // No glow: every outer shadow falls below the control, none spreads round it.
      for (const layer of hover.split(/,\s*(?![^()]*\))/).filter((part) => !part.startsWith("inset"))) {
        const [x, y] = layer.split(/\s+/).map((part) => parseFloat(part));
        expect(x).toBe(0);
        expect(y).toBeGreaterThan(0);
      }
    }
  }
});

test("primary, danger and highlight share one finish in their own colours; the others keep theirs", () => {
  const solid: Record<string, SolidTone> = { primary: "primary", danger: "danger", highlight: "warn" };
  for (const [variant, tone] of Object.entries(solid)) {
    const finish = buttonVariantFinish(variant as ButtonVariant);
    expect(finish.solid).toBe(tone);
    // The tone's fills, hairline, hover and pressed fills; the press deepens the fill itself (no
    // light layer over it), and disabled holds the fill at rest (faded by DISABLED_OPACITY).
    for (const c of classes(solidBox(tone))) expect(classes(finish.box)).toContain(c);
    expect(classes(solidBox(tone))).toContain(`active:bg-${SOLID_TONES[tone].press}`);
    expect(classes(solidBox(tone))).toContain(`hover:bg-${SOLID_TONES[tone].hover}`);
    expect(classes(solidBox(tone))).toContain(`border-${SOLID_TONES[tone].line}`);
    expect(finish.press).toBe("");
    expect(classes(finish.box).filter((c) => c.startsWith("disabled:"))).toEqual([`disabled:bg-${SOLID_TONES[tone].fill}`]);
    expect(classes(finish.box).some((c) => /press-light/.test(c))).toBe(false);
  }
  for (const variant of ["outlined", "plain", "ghost-danger", "outlined-danger"] as const) expect(buttonVariantFinish(variant).solid).toBeUndefined();
});

test("filled round buttons take the same fills and no disabled colours of their own; the capsule's primary is solid, its danger a pale stop", () => {
  const primary = classes(circleButtonClass({ variant: "primary" }));
  for (const c of classes(solidBox("primary"))) expect(primary).toContain(c);
  const danger = classes(circleButtonClass({ variant: "danger" }));
  for (const c of classes(solidBox("danger"))) expect(danger).toContain(c);
  expect(primary.filter((c) => c.startsWith("disabled:"))).toEqual(["disabled:bg-primary"]);
  expect(danger.filter((c) => c.startsWith("disabled:"))).toEqual(["disabled:bg-danger"]);
  expect([circleIconColor("primary"), circleIconColor("danger")]).toEqual(["primary-foreground", "on-accent"]);
  // The others are not filled.
  for (const variant of ["plain", "outlined", "close", "outlined-danger"] as const) expect(classes(circleButtonClass({ variant })).some((c) => c === "bg-primary" || c === "bg-danger")).toBe(false);

  const start = capsuleButtonLook("primary", "PhPlay");
  expect(start.solid).toBe("primary");
  for (const c of classes(solidBox("primary"))) expect(classes(start.box)).toContain(c);
  expect(start.ring).toBe("group-focus-visible:border-primary-foreground");
  // Disabled is the primary fill faded, and busy its own soft look, both without the finish.
  const startOff = capsuleButtonLook("primary", "PhPlay", { disabled: true });
  expect(startOff.solid).toBeUndefined();
  expect(classes(startOff.box)).toContain(DISABLED_OPACITY);
  expect(startOff.icon).toBe("primary-foreground");
  expect(capsuleButtonLook("primary", "PhPlay", { busy: true }).solid).toBeUndefined();
  // Stop is a pale red tint over the card, not a solid destructive fill: no finish, the quiet ring.
  const stop = capsuleButtonLook("danger", "PhStop");
  expect(stop.solid).toBeUndefined();
  expect(stop.ring).toBeUndefined();
  expect(classes(stop.box)).toContain("bg-card");
  expect(classes(stop.tint)).toContain("bg-danger/12");
  expect(CAPSULE_FOCUS_RING).toMatch(/^group-focus-visible:border-/);
});

/* ---------- drawn ---------- */

async function openSolid(platform: "linux" | "android" = "linux") {
  return open("./fixtures/solid-buttons-app.tsx", { width: 900, height: 700, platform, locale: "en-US" });
}
type App = Awaited<ReturnType<typeof openSolid>>;
const bg = (app: App, id: string) => app.viewStyle(`id:${id}`)?.backgroundColor;
const scheme = (app: App) => app.texts().find((text) => text.startsWith("scheme="));
/** Whether a control is drawn at the disabled opacity. */
const dimmed = (app: App, id: string) => app.viewStyle(`id:${id}`)?.opacity === 0.5;

async function checkLooks(app: App, s: Scheme) {
  expect(scheme(app)).toBe(`scheme=${reported(s, "background")}`);
  const variants: [ButtonVariant, SolidTone][] = [
    ["primary", "primary"],
    ["danger", "danger"],
    ["highlight", "warn"],
  ];
  for (const [variant, tone] of variants) {
    const t = SOLID_TONES[tone];
    expect(`${s} ${variant} ${bg(app, `rest-${variant}`)}`).toBe(`${s} ${variant} ${reported(s, t.fill)}`);
    expect(bg(app, `icon-${variant}`)).toBe(reported(s, t.fill));
    // Disabled: the fill at rest, faded, and so under the pointer too (no hover step).
    expect(bg(app, `disabled-${variant}`)).toBe(reported(s, t.fill));
    expect(dimmed(app, `disabled-${variant}`)).toBe(true);
    await app.hover(`id:disabled-${variant}`);
    expect(bg(app, `disabled-${variant}`)).toBe(reported(s, t.fill));
    // Loading is not faded.
    expect(dimmed(app, `loading-${variant}`)).toBe(false);
    // Loading: the soft tint the beam rides, not the solid fill.
    expect(bg(app, `loading-${variant}`)).not.toBe(reported(s, t.fill));
    // Selected: the toggles' soft blue, and it stays so under the pointer.
    expect(bg(app, `selected-${variant}`)).toBe(reported(s, "selection"));
    await app.hover(`id:selected-${variant}`);
    expect(bg(app, `selected-${variant}`)).toBe(reported(s, "selection"));
    // Hover: the fill's step.
    await app.hover(`id:rest-${variant}`);
    expect(`${s} ${variant} hover ${bg(app, `rest-${variant}`)}`).toBe(`${s} ${variant} hover ${reported(s, t.hover)}`);
    await app.hover("id:out-presses");
    expect(bg(app, `rest-${variant}`)).toBe(reported(s, t.fill));
  }
  expect(bg(app, "circle-primary")).toBe(reported(s, "primary"));
  expect(bg(app, "circle-primary-disabled")).toBe(reported(s, "primary"));
  expect(dimmed(app, "circle-primary-disabled")).toBe(true);
  expect(bg(app, "circle-danger")).toBe(reported(s, "danger"));
  expect(bg(app, "circle-danger-disabled")).toBe(reported(s, "danger"));
  expect(dimmed(app, "circle-danger-disabled")).toBe(true);
  await app.hover("id:circle-danger");
  expect(bg(app, "circle-danger")).toBe(reported(s, "danger-hover"));
  expect(bg(app, "capsule-primary")).toBe(reported(s, "primary"));
  expect(bg(app, "capsule-primary-disabled")).toBe(reported(s, "primary"));
  expect(dimmed(app, "capsule-primary-disabled")).toBe(true);
  await app.hover("id:capsule-primary");
  expect(bg(app, "capsule-primary")).toBe(reported(s, "primary-hover"));
  await app.hover("id:out-presses");
}

test("drawn: each solid control's fill at rest, on hover, disabled, loading and selected, light then dark", async () => {
  const app = await openSolid();
  expect(app.texts()).toContain("shadows=true");
  await checkLooks(app, "light");
  await app.press("id:set-dark");
  await app.waitUntil(() => scheme(app) === `scheme=${reported("dark", "background")}`);
  await checkLooks(app, "dark");
});

test("drawn: presses act on the enabled ones only", async () => {
  const app = await openSolid();
  for (const id of ["rest-primary", "icon-danger", "rest-highlight", "circle-primary", "circle-danger", "capsule-primary", "capsule-danger"]) await app.press(`id:${id}`);
  expect(app.texts()).toContain("presses=7");
  for (const id of ["disabled-primary", "disabled-danger", "disabled-highlight", "loading-primary", "circle-primary-disabled", "circle-danger-disabled", "capsule-primary-disabled"]) {
    expect(app.enabled(`id:${id}`)).toBe(false);
    await expect(app.press(`id:${id}`)).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  }
  expect(app.texts()).toContain("presses=7");
});

test("Android draws the fills and hairlines without the shadows, and its solid buttons still take presses", async () => {
  const app = await openSolid("android");
  expect(app.texts()).toContain("shadows=false");
  expect(bg(app, "rest-primary")).toBe(reported("light", "primary"));
  expect(bg(app, "circle-danger")).toBe(reported("light", "danger"));
  for (const id of ["rest-primary", "rest-danger", "rest-highlight", "circle-primary", "capsule-primary"]) await app.press(`id:${id}`);
  expect(app.texts()).toContain("presses=5");
});
