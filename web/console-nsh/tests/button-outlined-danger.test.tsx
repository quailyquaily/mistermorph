// The outlined danger button (components/ui.tsx, `variant="outlined-danger"`): the outlined
// button's box (translucent fill, 1pt hairline, corners, sizes) in the danger colour, the quieter
// of two destructive buttons beside the solid `danger`. Hover, focus, press and selected take the
// red tint (not the neutral one); disabled fades to the danger button's pale reds; loading keeps
// that look with the red beam, and blocks presses. The same as a text and an icon button in every
// size, and as a round CircleButton; the other variants are as they were. Headless nsh has no view
// style query: text colours are read with `spanStyle`, glyph tints from the glyph's test id
// (`<button>-glyph.<token>`), boxes from the looks the Button draws, and contrast from the theme's
// colours in the light and the dark appearance (tests/fixtures/button-variants-app.tsx).
import { expect, open, test } from "nsh/test";

const SIZES = ["md", "sm", "xs", "xxs"] as const;
const VARIANT = "outlined-danger";
/** The least a press may leave the red label, by appearance: the bound the press tints were tuned
 * against, 4.5:1 capped by the old solid danger hover's contrast (`danger-light`, since replaced by
 * the solid finish's deeper `danger-hover`, solidLook.ts): 4.35:1 in light, 4.5:1 in dark. */
const PRESS_FLOOR = { light: 4.35, dark: 4.5 } as const;

type Look = {
  box: string;
  text: string;
  textClass: string;
  disabledText: string;
  press: string;
  focus: string;
  selectedBox: string;
  selectedText: string;
  beam: string;
  loading: { box: string; text: string };
};
type Report = {
  frames: Record<string, { w: number; h: number }>;
  presses: Record<string, number>;
  looks: Record<string, Look>;
  circles: Record<string, string>;
  scheme: string;
  colours: Record<string, string>;
};

async function openVariants(colorScheme: "light" | "dark" = "light") {
  const app = await open("./fixtures/button-variants-app.tsx", { width: 1400, height: 4200, platform: "linux", locale: "en-US", colorScheme });
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith('{"frames"')) ?? "{}") as Report;
  await app.waitUntil(() => SIZES.every((size) => report().frames?.[`text-${VARIANT}-${size}`] && report().frames?.[`busy-outlined-${size}`]));
  // The console shows the appearance chosen in its Settings (setColorScheme), as the fixture does here.
  await app.press(`id:set-${colorScheme}`);
  await app.waitUntil(() => report().scheme === colorScheme);
  // The palettes differ: the page is dark in the dark appearance.
  expect(report().colours.background).toBe(colorScheme === "dark" ? "#0f0f0fff" : "#f3f7fbff");
  return { app, report };
}

type Rgba = [number, number, number, number];

function rgba(hex: string): Rgba {
  const digits = hex.replace("#", "");
  const full = digits.length === 6 ? `${digits}ff` : digits;
  return [0, 2, 4, 6].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as Rgba;
}

/** `top` at `alpha` (its own by default) laid over the opaque `under`. */
function over(top: Rgba, under: Rgba, alpha = top[3]): Rgba {
  return [0, 1, 2].map((i) => top[i] * alpha + under[i] * (1 - alpha)).concat(1) as Rgba;
}

function luminance(color: Rgba) {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const classes = (value: string) => value.split(/\s+/).filter(Boolean);
/** Every one of `wanted` is in `list`. */
const expectAll = (list: string[], wanted: string[]) => expect(wanted.filter((item) => !list.includes(item))).toEqual([]);
/** The alpha of a `<prefix>danger/<n>` class in `value` (1 without a modifier). */
function dangerAlpha(value: string, prefix: string) {
  const match = classes(value).find((c) => c.startsWith(`${prefix}danger`));
  expect(match).toBeDefined();
  const [, n] = match!.split("/");
  return n ? Number(n) / 100 : 1;
}

test("its look: the outlined box with a red hairline and red text, the red tint on hover, focus, press and selected", async () => {
  const { report } = await openVariants();
  const look = report().looks[VARIANT];
  const outlined = report().looks.outlined;
  const box = classes(look.box);
  // The outlined box: its translucent fill and 1pt hairline, its shadow-bearing shape.
  expect(box).toContain("bg-outline-bg");
  expect(box).toContain("border");
  expectAll(classes(outlined.box), ["bg-outline-bg", "border"]);
  // In red, not the neutral hairline or its neutral hover.
  expect(box.some((c) => c.startsWith("border-danger"))).toBe(true);
  expect(box).not.toContain("border-line");
  expect(box.some((c) => c.includes("outline-line"))).toBe(false);
  expect(box).toContain("hover:bg-close");
  expect(box.some((c) => c.startsWith("hover:border-danger"))).toBe(true);
  expect(box.some((c) => c.includes("outline-bg-hover"))).toBe(false);
  expect(classes(look.focus)).toContain("focus:bg-close");
  expect(classes(look.focus).some((c) => c.startsWith("focus:border-danger"))).toBe(true);
  expect(look.press).toBe("group-active:bg-danger/4");
  expect(classes(look.selectedBox)).toContain("bg-danger/12");
  expect(look.selectedBox).not.toContain("bg-selection");
  // Text and glyph: red, and red while disabled too (the whole button fades, DISABLED_OPACITY).
  expect(look.text).toBe("danger");
  expect(look.selectedText).toBe("danger");
  expect(look.textClass).toBe("text-danger group-disabled:text-danger");
  // Disabled holds the box at rest (the button fades as a whole).
  expect(box.filter((c) => c.startsWith("disabled:"))).toEqual(["disabled:bg-outline-bg", "disabled:border-danger/45"]);
  // Loading: the red beam, as the danger button's, on its own box (as outlined keeps), red text.
  expect(look.beam).toBe("red");
  expect(look.beam).toBe(report().looks.danger.beam);
  expect(look.loading).toEqual({ box: "", text: "danger" });
});

test("the other variants are as they were: no focus look of their own, the blue selection, their own colours", async () => {
  const { report } = await openVariants();
  const looks = report().looks;
  expect(Object.keys(looks)).toEqual(["primary", "outlined", "plain", "danger", "highlight", "ghost-danger", "outlined-danger"]);
  for (const variant of ["primary", "outlined", "plain", "danger", "highlight", "ghost-danger"]) {
    expect(looks[variant].focus).toBe("");
    expect(looks[variant].selectedBox).toBe("bg-selection");
    expect(looks[variant].selectedText).toBe("ink");
  }
  expect(looks.outlined.box).toBe(
    "bg-outline-bg border border-line hover:bg-outline-bg-hover hover:border-outline-line-hover disabled:bg-outline-bg disabled:border-line",
  );
  expect(looks.outlined.text).toBe("foreground");
  expect(looks.outlined.beam).toBe("blue");
  expect(looks["ghost-danger"]).toMatchObject({ box: "hover:bg-close disabled:bg-transparent", text: "danger", press: "group-active:bg-press", beam: "red" });
  expect(looks.danger).toMatchObject({ text: "on-accent", beam: "red", loading: { box: "bg-danger/10 border-[0.5px] border-danger/35", text: "danger" } });
});

for (const size of SIZES) {
  test(`${size}: text and icon buttons in red, the outlined button's size, faded when disabled, red when loading or selected`, async () => {
    const { app, report } = await openVariants();
    const colours = report().colours;
    const text = (id: string) => app.spanStyle(`id:${id} >> text:Delete`);

    // The text button draws its label in red at the outlined button's size and type.
    expect(text(`text-${VARIANT}-${size}`).color).toBe(colours.danger);
    expect(text(`text-${VARIANT}-${size}`).fontSize).toBe(text(`text-outlined-${size}`).fontSize);
    expect(text(`text-${VARIANT}-${size}`).fontWeight).toBe(text(`text-outlined-${size}`).fontWeight);
    expect(report().frames[`text-${VARIANT}-${size}`]).toEqual(report().frames[`text-outlined-${size}`]);
    // The icon button draws the glyph alone, red, in the outlined icon button's square.
    expect(app.count(`id:icon-${VARIANT}-${size}-glyph.danger`)).toBe(1);
    expect(app.count(`id:icon-${VARIANT}-${size} >> text:Delete`)).toBe(0);
    expect(report().frames[`icon-${VARIANT}-${size}`]).toEqual(report().frames[`icon-outlined-${size}`]);

    // Disabled: the red button faded, and no press.
    expect(text(`off-${VARIANT}-${size}`).color).toBe(colours.danger);
    expect(app.count(`id:off-icon-${VARIANT}-${size}-glyph.danger`)).toBe(1);
    expect(app.viewStyle(`id:off-${VARIANT}-${size}`)?.opacity).toBe(0.5);
    expect(app.enabled(`id:off-${VARIANT}-${size}`)).toBe(false);
    await expect(app.press(`id:off-${VARIANT}-${size}`)).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });

    // Loading: the beam runs round it, the label stays (red, not faded), presses are blocked, the size kept.
    expect(app.shows(`id:busy-${VARIANT}-${size}-loading`)).toBe(true);
    expect(app.shows(`id:busy-icon-${VARIANT}-${size}-loading`)).toBe(true);
    expect(text(`busy-${VARIANT}-${size}`).color).toBe(colours.danger);
    expect(app.count(`id:busy-icon-${VARIANT}-${size}-glyph.danger`)).toBe(1);
    expect(app.viewStyle(`id:busy-${VARIANT}-${size}`)?.opacity).toBe(1);
    expect(app.enabled(`id:busy-${VARIANT}-${size}`)).toBe(false);
    await expect(app.press(`id:busy-${VARIANT}-${size}`)).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
    expect(report().frames[`busy-${VARIANT}-${size}`]).toEqual(report().frames[`text-${VARIANT}-${size}`]);

    // Selected: red stays red (outlined turns ink), text and glyph.
    expect(text(`on-${VARIANT}-${size}`).color).toBe(colours.danger);
    expect(app.count(`id:on-icon-${VARIANT}-${size}-glyph.danger`)).toBe(1);
    expect(text(`on-outlined-${size}`).color).toBe(colours.ink);
    expect(app.count(`id:on-icon-outlined-${size}-glyph.ink`)).toBe(1);

    // It presses.
    await app.press(`id:text-${VARIANT}-${size}`);
    await app.press(`id:icon-${VARIANT}-${size}`);
    await app.press(`id:on-${VARIANT}-${size}`);
    expect(report().presses).toEqual({ [`text-${VARIANT}-${size}`]: 1, [`icon-${VARIANT}-${size}`]: 1, [`on-${VARIANT}-${size}`]: 1 });
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme}: the red label reads on its box in every state, and the hairline is no fainter than the outlined one`, async () => {
    const { report } = await openVariants(colorScheme);
    const look = report().looks[VARIANT];
    const c = (name: string) => rgba(report().colours[name]);
    for (const paper of ["card", "background"]) {
      const under = c(paper);
      const idle = over(c("outline-bg"), under);
      const tint = (value: string, prefix: string) => over(c("danger"), under, dangerAlpha(value, prefix));
      const hover = over(c("close"), under);
      const pressed = over(c("danger"), hover, dangerAlpha(look.press, "group-active:bg-"));
      const selected = tint(look.selectedBox, "bg-");
      const selectedPressed = over(c("danger"), selected, dangerAlpha(look.press, "group-active:bg-"));
      // Text contrast (4.5:1) at rest, hovered or focused, and selected, as the outlined button's
      // text keeps on its box; a press (a moment) may dip a little under it, to no less than
      // PRESS_FLOOR (under 4.5:1 in the light appearance only).
      for (const fill of [idle, hover, selected]) expect(contrast(c("danger"), fill)).toBeGreaterThan(4.5);
      for (const fill of [pressed, selectedPressed]) expect(contrast(c("danger"), fill)).toBeGreaterThanOrEqual(PRESS_FLOOR[colorScheme]);
      expect(contrast(c("foreground"), idle)).toBeGreaterThan(4.5);
      // The hover, focus and press tints show on the box (not the neutral white of outlined).
      expect(contrast(hover, idle)).toBeGreaterThan(1.03);
      // Selected: a red tint that shows on the box (about as deep as hover's), with the deeper hairline.
      expect(contrast(selected, idle)).toBeGreaterThan(1.03);
      expect(dangerAlpha(look.selectedBox, "border-")).toBe(dangerAlpha(look.box, "hover:border-"));
      // The round one's tints read the same way on the bare paper.
      const ring = report().circles[VARIANT];
      expect(contrast(c("danger"), over(c("close"), under))).toBeGreaterThan(4.5);
      expect(contrast(c("danger"), tint(ring, "selected:bg-"))).toBeGreaterThan(4.5);
      expect(contrast(c("danger"), tint(ring, "active:bg-"))).toBeGreaterThanOrEqual(PRESS_FLOOR[colorScheme]);
      // The hairline: at least as strong as the outlined button's, stronger on hover and focus.
      const line = over(c("danger"), idle, dangerAlpha(look.box, "border-"));
      const neutral = over(c("line"), idle);
      expect(contrast(line, idle)).toBeGreaterThanOrEqual(contrast(neutral, idle));
      const hoverLine = over(c("danger"), hover, dangerAlpha(look.box, "hover:border-"));
      expect(contrast(hoverLine, hover)).toBeGreaterThan(contrast(over(c("danger"), hover, dangerAlpha(look.box, "border-")), hover));
      expect(dangerAlpha(look.focus, "focus:border-")).toBe(dangerAlpha(look.box, "hover:border-"));
    }
  });
}

test("CircleButton outlined-danger: a red ring and red glyph, the red tint on hover, focus, press and selected, faded when disabled", async () => {
  const { app, report } = await openVariants();
  const ring = classes(report().circles[VARIANT]);
  expectAll(ring, ["border", "bg-transparent", "hover:bg-close", "focus:bg-close", "active:bg-danger/12", "selected:bg-danger/12", "rounded-full"]);
  expect(ring.filter((c) => c.startsWith("disabled:"))).toEqual(["disabled:bg-transparent", "disabled:border-danger/45"]);
  expect(ring.some((c) => c.startsWith("border-danger/"))).toBe(true);
  expect(ring.some((c) => c.includes("line-soft"))).toBe(false);
  // The other round variants keep their looks (danger has the solid finish, solidLook.ts).
  expect(report().circles.outlined).toContain("border border-line-soft bg-transparent hover:bg-hover active:bg-press");
  expect(report().circles.danger).toContain("bg-danger border-[0.5px] border-danger-line hover:bg-danger-hover active:bg-danger-press");

  expect(app.count(`id:circle-${VARIANT}-glyph.danger`)).toBe(1);
  expect(app.count(`id:circle-${VARIANT}-sm-glyph.danger`)).toBe(1);
  expect(app.count(`id:circle-${VARIANT}-on-glyph.danger`)).toBe(1);
  expect(app.count(`id:circle-${VARIANT}-off-glyph.danger`)).toBe(1);
  expect(app.viewStyle(`id:circle-${VARIANT}-off`)?.opacity).toBe(0.5);
  // Other variants' glyphs keep their colours, disabled or not.
  expect(app.count("id:circle-outlined-off-glyph.subtle")).toBe(1);
  expect(app.count("id:circle-danger-glyph.on-accent")).toBe(1);
  // The circle sizes: 38 and 32.
  expect(report().frames[`circle-${VARIANT}`]).toEqual({ w: 38, h: 38 });
  expect(report().frames[`circle-${VARIANT}-sm`]).toEqual({ w: 32, h: 32 });
  expect(report().frames[`circle-${VARIANT}`]).toEqual(report().frames["circle-outlined"]);

  await app.press(`id:circle-${VARIANT}`);
  expect(report().presses[`circle-${VARIANT}`]).toBe(1);
  expect(app.enabled(`id:circle-${VARIANT}-off`)).toBe(false);
  await expect(app.press(`id:circle-${VARIANT}-off`)).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  // Named and tipped by its title.
  expect(app.count(`label:Circle ${VARIANT}`)).toBe(1);
});
