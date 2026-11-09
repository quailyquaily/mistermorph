// The phone's floating bottom bar's room (components/frame/MobileBottomNav.tsx): the bar floats
// over the foot of the page, so each page's main list ends with MobileBarSpacer to scroll its last
// row clear of it.
import { safeArea, View } from "nsh";
import { mobileBottomNavVisible, systemInsets } from "../../lib/shell";

/** The capsule's height: 44pt slots inset 4pt all round. */
export const MOBILE_NAV_HEIGHT = 58;
/** The capsule's gap above the bottom safe area. */
export const BAR_BELOW = 8;
/** Room left between the end of a page's list and the capsule's top. */
const BAR_CLEARANCE = 12;

/** The capsule's inset from the window's sides, its padding round the slots, and its hairline. */
export const BAR_SIDE = 12;
export const BAR_INSET = 4;
const BAR_BORDER = 0.5;
/** A slot's width where the window has room for it. */
export const NAV_SLOT_MAX = 60;

/**
 * The capsule's slots in a strip `width` wide: `count` slots side by side, none reaching under its
 * neighbour, each as wide as the room allows up to NAV_SLOT_MAX (on whole points, so the row never
 * outgrows the capsule). Slot `i` starts at `slot * i`; the active pill is one slot, placed the same way.
 */
export function mobileNavSlots(width: number, count: number) {
  const room = width - 2 * (BAR_SIDE + BAR_INSET + BAR_BORDER);
  const slot = count > 0 ? Math.max(0, Math.min(NAV_SLOT_MAX, Math.floor(room / count))) : NAV_SLOT_MAX;
  return { slot, rowWidth: slot * Math.max(0, count), left: (index: number) => slot * index };
}

/** The room the floating bar takes at the foot of the window, clearance included (0 while it is not shown). */
export function mobileBarRoom() {
  if (!mobileBottomNavVisible()) return 0;
  const below = systemInsets() ? systemInsets()!.bottomNav : safeArea().bottom;
  return MOBILE_NAV_HEIGHT + BAR_BELOW + below + BAR_CLEARANCE;
}

/**
 * The end of a page's main list on a phone: as tall as the floating bar's room, so the last row
 * scrolls clear of it. Put it last in the list's content (a `List`'s `footer`); nothing shows
 * while the bar is not there.
 */
export function MobileBarSpacer() {
  return (
    <If when={mobileBarRoom() > 0}>
      <View accessibilityElementsHidden style={{ height: mobileBarRoom() }} />
    </If>
  );
}
