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
