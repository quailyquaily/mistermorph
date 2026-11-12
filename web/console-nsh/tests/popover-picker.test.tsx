// PopoverPicker's placement (components/shared/PopoverPicker.tsx): the preferred side when it has the
// room, the other when only that one has; the offset clears what is around the trigger on that side;
// the list is held to the side's room.
import { expect, test } from "nsh/test";
import { choosePickerPlacement } from "../components/shared/PopoverPicker";

const base = { height: 38, windowHeight: 900, clearance: { top: 60, bottom: 9 }, gap: 8, margin: 8, max: 384, min: 160 };

test("above when the room above holds the list, clearing what is above the trigger", () => {
  // The composer at the window's foot: 700pt above the picker.
  expect(choosePickerPlacement({ ...base, top: 700 })).toEqual({ side: "top", offset: 68, maxHeight: 384 });
});

test("below when the room above is short and below has more (a composer near the top)", () => {
  const placed = choosePickerPlacement({ ...base, top: 200 });
  expect(placed.side).toBe("bottom");
  expect(placed.offset).toBe(17);
  expect(placed.maxHeight).toBe(384);
});

test("above, shortened, when above is short but still the roomier side", () => {
  const placed = choosePickerPlacement({ ...base, windowHeight: 600, top: 330 });
  // Above: 330 - 68 - 8 = 254; below: 600 - 368 - 17 - 8 = 207.
  expect(placed).toEqual({ side: "top", offset: 68, maxHeight: 254 });
});

test("never shorter than its least, and the preferred side while the trigger is unmeasured", () => {
  expect(choosePickerPlacement({ ...base, windowHeight: 300, top: 120 }).maxHeight).toBe(160);
  expect(choosePickerPlacement({ ...base, top: null })).toEqual({ side: "top", offset: 68, maxHeight: 384 });
  expect(choosePickerPlacement({ ...base, top: null, preferred: "bottom" }).side).toBe("bottom");
});

test("the sidebar's agent switcher opens below it, the phone's agent slot above it (FT100)", () => {
  // The sidebar's switcher: the window's top 56pt, its hairline under it; the bubble below.
  const sidebar = choosePickerPlacement({ top: 0, height: 56, windowHeight: 800, preferred: "bottom", clearance: { bottom: 1 }, gap: 12 });
  expect(sidebar).toEqual({ side: "bottom", offset: 13, maxHeight: 384 });
  // On a short window it stays below (no room above the window's top), shortened to the room.
  const short = choosePickerPlacement({ top: 0, height: 56, windowHeight: 360, preferred: "bottom", clearance: { bottom: 1 }, gap: 12 });
  expect(short).toEqual({ side: "bottom", offset: 13, maxHeight: 360 - 56 - 13 - 8 });
  // The phone's agent slot at the foot of a 640pt window, in its capsule: above.
  const phone = choosePickerPlacement({ top: 580, height: 48, windowHeight: 640, preferred: "top", clearance: { top: 4 }, gap: 12 });
  expect(phone).toEqual({ side: "top", offset: 16, maxHeight: 384 });
  // A phone in landscape: still above, held to the room there.
  const landscape = choosePickerPlacement({ top: 300, height: 48, windowHeight: 360, preferred: "top", clearance: { top: 4 }, gap: 12 });
  expect(landscape).toEqual({ side: "top", offset: 16, maxHeight: 300 - 16 - 8 });
});
