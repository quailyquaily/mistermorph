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
