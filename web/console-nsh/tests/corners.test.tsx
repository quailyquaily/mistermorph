// The console's continuous corners (components/corners.ts): one scale of radii from the theme
// (controls 8, cards and popovers 12, dialogs 18, switch tracks 6), all drawn with nsh's
// `borderCurve: "continuous"`, nested corners derived from the outer radius and the inset, circles
// left round, and nothing else about the controls changed. Headless tests cannot read a radius or
// a corner curve back from a view: the shapes are checked through the classes and numbers the
// components are built from, the sizes through the frames the controls lay out at
// (tests/fixtures/corners-app.tsx), and the drawing by eye on the web target (docs/console/corners.md).
import { token } from "nsh";
import { expect, open, test } from "nsh/test";
import {
  CARD_CORNERS,
  CONTINUOUS,
  CONTROL_CORNERS,
  cornerReach,
  cornersClass,
  DIALOG_CORNERS,
  fittingRadius,
  nestedRadius,
  POPOVER_CORNERS,
  RADIUS,
  TRACK_CORNERS,
} from "../components/corners";
import { PAPER_ROW_RADIUS } from "../components/shared/PickerList";
import { FIELD_FRAME } from "../components/todo/TodoFields";
import {
  buttonCorners,
  circleButtonClass,
  MENU_ITEM_BOX,
  MENU_ITEM_CORNERS,
  MENU_ITEM_RADIUS,
  MENU_POPUP,
  POPUP_RADIUS,
  POPUP_ROW_RADIUS,
  SWITCH_THUMB_CORNERS,
  SWITCH_TRACK_CORNERS,
} from "../components/ui";

test("the radii are the theme's tokens: controls 8, cards and popovers 12, dialogs 18, tracks 6", () => {
  expect(RADIUS).toEqual({ control: 8, card: 12, popover: 12, dialog: 18, track: 6 });
  // The classes name the theme's tokens, the computed corners read RADIUS: the two are one scale.
  expect({
    control: token("radius-control"),
    card: token("radius-card"),
    popover: token("radius-popover"),
    dialog: token("radius-dialog"),
    track: token("radius-track"),
  }).toEqual(RADIUS);
  // The generic radius stays for the small marks and tags outside the scale.
  expect(token("radius")).toBe(2);
});

test("every shape class is the continuous curve on its token", () => {
  expect(CONTINUOUS).toBe("corner-squircle");
  expect(CONTROL_CORNERS).toBe("rounded-(--radius-control) corner-squircle");
  expect(CARD_CORNERS).toBe("rounded-(--radius-card) corner-squircle");
  expect(POPOVER_CORNERS).toBe("rounded-(--radius-popover) corner-squircle");
  expect(DIALOG_CORNERS).toBe("rounded-(--radius-dialog) corner-squircle");
  expect(TRACK_CORNERS).toBe("rounded-(--radius-track) corner-squircle");
  expect(cornersClass(3)).toBe("rounded-[3px] corner-squircle");
});

test("nested corners are the outer radius less the inset, never below 0", () => {
  expect(nestedRadius(12, 9)).toBe(3);
  expect(nestedRadius(6, 3)).toBe(3);
  expect(nestedRadius(8, 13)).toBe(0);
  // A menu's item: inset by the menu's hairline and its 8pt padding, its text still 16pt in.
  expect(MENU_POPUP).toContain(POPOVER_CORNERS);
  expect(MENU_POPUP).toContain("border ");
  expect(MENU_POPUP).toContain("py-2");
  expect(MENU_ITEM_RADIUS).toBe(3);
  expect(MENU_ITEM_CORNERS).toBe("rounded-[3px] corner-squircle");
  expect(MENU_ITEM_BOX).toBe("mx-2 px-2 rounded-[3px] corner-squircle");
  // The phone's floating paper: the dialogs' 18pt, its rows nested by the hairline and p-2.
  expect(POPUP_RADIUS).toBe(18);
  expect(POPUP_ROW_RADIUS).toBe(9);
  expect(PAPER_ROW_RADIUS).toBe(9);
  // A switch's thumb in its track's hairline and 2pt padding.
  expect(SWITCH_TRACK_CORNERS).toBe(TRACK_CORNERS);
  expect(SWITCH_THUMB_CORNERS).toBe("rounded-[3px] corner-squircle");
});

test("a radius too large for a small control is cut to one whose curve fits it", () => {
  // The web draws a continuous corner only where 1.53 times the radius fits half the side.
  expect(cornerReach(12)).toBe(19);
  expect(fittingRadius(8, 44)).toBe(8);
  expect(fittingRadius(8, 32)).toBe(8);
  expect(fittingRadius(8, 24)).toBe(7);
  expect(fittingRadius(6, 20)).toBe(6);
  expect(buttonCorners("sm")).toEqual({ radius: 8, corners: CONTROL_CORNERS });
  expect(buttonCorners("xs")).toEqual({ radius: 8, corners: CONTROL_CORNERS });
  expect(buttonCorners("xxs")).toEqual({ radius: 7, corners: "rounded-[7px] corner-squircle" });
});

test("circles stay circles", () => {
  for (const size of ["md", "sm"] as const) {
    const cls = circleButtonClass({ size });
    expect(cls).toContain("rounded-full");
    expect(cls).not.toContain("corner-squircle");
  }
});

test("the TODO editor's fields share the controls' corners", () => {
  expect(FIELD_FRAME).toContain(CONTROL_CORNERS);
});

type Frame = [number, number, number, number];

async function openGallery(platform: "linux" | "android" = "linux") {
  const app = await open("./fixtures/corners-app.tsx", { width: 1100, height: 760, platform, locale: "en-US" });
  await app.waitFor("id:frames");
  return app;
}

function framesOf(app: { texts(): string[] }): Record<string, Frame> {
  const line = app.texts().find((text) => text.startsWith("frames="));
  return JSON.parse(line?.slice("frames=".length) ?? "{}");
}

for (const platform of ["linux", "android"] as const) {
  test(`the controls keep their sizes (${platform})`, async () => {
    const app = await openGallery(platform);
    await app.waitUntil(() => Object.keys(framesOf(app)).length >= 18);
    const f = framesOf(app);
    // Buttons: md 44, sm 38, xs 32, xxs 24 tall; an icon button is as wide as it is tall.
    expect([f["button-md"][3], f["button-sm"][3], f["button-xs"][3], f["button-xxs"][3]]).toEqual([44, 38, 32, 24]);
    for (const [size, side] of [["md", 44], ["sm", 38], ["xs", 32], ["xxs", 24]] as const) {
      expect(f[`icon-${size}`].slice(2)).toEqual([side, side]);
    }
    // A round button stays 38pt.
    expect(f.circle.slice(2)).toEqual([38, 38]);
    // Fields: md 44, sm 38, xs 32 tall, holding a value longer than they are wide.
    expect([f["field-md"][3], f["field-sm"][3], f["field-xs"][3]]).toEqual([44, 38, 32]);
    expect(f["field-md"][2]).toBe(224);
    // A switch's track: 34 by 20.
    expect(f.switch.slice(2)).toEqual([34, 20]);
    expect(f.select[3]).toBe(44);
    // A card keeps its padding round its content.
    expect(f["card-content"].slice(0, 2)).toEqual([13, 13]);
  });
}

test("a menu item's highlight is inset, its text where it was", async () => {
  const app = await openGallery();
  await app.waitUntil(() => !!framesOf(app)["menu-item-text-before"] && !!framesOf(app)["menu-item-text"]);
  const f = framesOf(app);
  // The highlight stands 8pt in from the paper's sides (past its hairline), as from its top.
  expect(f["menu-item"][0]).toBe(f["menu-item-before"][0] + 8);
  expect(f["menu-item"][2]).toBe(f["menu-item-before"][2] - 16);
  // The text: 16pt in from the paper's hairline, as before.
  expect(f["menu-item"][0] + f["menu-item-text"][0]).toBe(f["menu-item-before"][0] + f["menu-item-text-before"][0]);
  expect(f["menu-item"][3]).toBe(f["menu-item-before"][3]);
});

test("the menu, the select list and the dialog still open, choose and close", async () => {
  const app = await openGallery();
  await app.press("id:menu-trigger");
  await app.waitFor("role:menuitem[First action]");
  await app.press("role:menuitem[First action]");
  await app.waitFor("role:menuitem", { state: "gone" });

  await app.press("id:select");
  await app.waitFor("role:menuitemcheckbox[Plum]");
  await app.press("role:menuitemcheckbox[Plum]");
  await app.waitFor("role:menuitemcheckbox", { state: "gone" });
  expect(app.texts()).toContain("Plum");

  await app.press("id:open-dialog");
  await app.waitFor("id:dialog-close");
  await app.press("id:dialog-close");
  await app.waitFor("id:dialog-close", { state: "gone" });
});

test("the clear button still empties a long value", async () => {
  const app = await openGallery();
  expect(app.value("id:field-md")).toContain("an_unbroken_identifier");
  await app.press("id:field-md-clear");
  expect(app.value("id:field-md")).toBe("");
});
