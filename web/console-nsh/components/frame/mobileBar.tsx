// The phone's floating bottom bar's room (components/frame/MobileBottomNav.tsx): the bar floats
// over the foot of the page, so each page's main list ends with MobileBarSpacer to scroll its last
// row clear of it.
import type { JSX } from "nsh";
import { platform, safeArea, View } from "nsh";
import { glassClass, glassEnabled, glassStyle } from "../../lib/glass";
import { mobileBottomNavVisible, phoneWorkbenchOpen, systemInsets } from "../../lib/shell";
import { mobilePopupFrame, type MobilePopupFrame } from "../../lib/mobilePopup";
import type { Edges } from "../../lib/systemInsets";

/** The capsule's height, compact (icons only): 50pt slots inset 4pt all round. */
export const MOBILE_NAV_HEIGHT = 58;
/**
 * The capsule's height expanded (icons over their labels): 56pt slots inset 4pt all round. The
 * most it takes, so the pages' room for it (mobileBarRoom) is this whichever way it shows: the
 * capsule compacting or expanding never moves the page.
 */
export const MOBILE_NAV_EXPANDED_HEIGHT = 64;
/** The capsule's gap above the bottom safe area. */
export const BAR_BELOW = 8;
/** Room left between the end of a page's list and the capsule's top. */
const BAR_CLEARANCE = 12;

/** The capsule's inset from the window's sides, its padding round the slots, and its hairline. */
export const BAR_SIDE = 12;
export const BAR_INSET = 4;
const BAR_BORDER = 0.5;
/** The capsule's outer shadow (none on Android, where it would not follow the corners). */
const BAR_SHADOW = "0 6px 20px rgba(14, 44, 87, 0.10), 0 1px 3px rgba(14, 44, 87, 0.06)";
/** A slot's width where the window has room for it (the compact capsule). */
export const NAV_SLOT_MAX = 60;
/** A slot's width where the window has room for it, expanded: room for its label. */
export const NAV_SLOT_EXPANDED_MAX = 76;

/**
 * The capsule's slots in a strip `width` wide: `count` slots side by side, none reaching under its
 * neighbour, each as wide as the room allows up to NAV_SLOT_MAX (NAV_SLOT_EXPANDED_MAX `expanded`;
 * on whole points, so the row never outgrows the capsule). Slot `i` starts at `slot * i`; the
 * active pill is one slot, placed the same way.
 */
export function mobileNavSlots(width: number, count: number, expanded = false) {
  const max = expanded ? NAV_SLOT_EXPANDED_MAX : NAV_SLOT_MAX;
  const room = width - 2 * (BAR_SIDE + BAR_INSET + BAR_BORDER);
  const slot = count > 0 ? Math.max(0, Math.min(max, Math.floor(room / count))) : max;
  return { slot, rowWidth: slot * Math.max(0, count), left: (index: number) => slot * index };
}

/** The share of the page's height More's and the agents' popup may take. */
export const SHEET_MAX_SHARE = 0.62;

/**
 * Where More's and the agents' popup goes (MobileBottomNav) in a page `width` by `height` whose
 * bar takes `barRoom` (mobileBarRoom()): the shared phone paper (lib/mobilePopup.ts), a small gap
 * in from the page's sides and above the bar (the bar's room ends with that gap; without a bar,
 * above the bottom inset), 62% of the page at most. `area` is the system's insets the page lies
 * under (none of those Android's frame takes), `keyboard` the keyboard's height over its foot.
 */
export function mobileSheetFrame(width: number, height: number, barRoom: number, area: Partial<Edges> = {}, keyboard = 0): MobilePopupFrame {
  return mobilePopupFrame({ width, height, area, keyboard, below: barRoom, share: SHEET_MAX_SHARE });
}

/**
 * The room the floating bar takes at the foot of the window, clearance included (0 while it is not
 * shown): for the expanded capsule, the taller, whether it is expanded or compact now.
 */
export function mobileBarRoom() {
  if (!mobileBottomNavVisible()) return 0;
  // The bottom inset under the bar, unless the open workbench below the page takes it.
  const below = systemInsets() ? systemInsets()!.bottomNav : phoneWorkbenchOpen() ? 0 : safeArea().bottom;
  return MOBILE_NAV_EXPANDED_HEIGHT + BAR_BELOW + below + BAR_CLEARANCE;
}

/**
 * The end of a page's main list on a phone: as tall as the floating bar's room, so the last row
 * scrolls clear of it. Put it last in the list's content (a `List`'s `footer`), or last in a column
 * whose foot holds a fixed control (the chat's composer); nothing shows while the bar is not there.
 */
export function MobileBarSpacer(props: { testID?: string } = {}) {
  return (
    <If when={mobileBarRoom() > 0}>
      <View accessibilityElementsHidden testID={props?.testID} style={{ height: mobileBarRoom() }} />
    </If>
  );
}

/**
 * The bottom navigation's capsule (MobileBottomNav), for any bar of controls that floats over a page
 * the same way (a TODO topic's toolbar, TodoJobBar): a pill with the navigation's hairline, inset and
 * shadow, glass where the window draws it (lib/glass.ts), else the card's own opaque fill. Its test
 * id gains `.glass` while it is glass.
 */
export function GlassCapsule(props: {
  testID: string;
  role?: "toolbar" | "group";
  accessibilityLabel?: string;
  class?: string;
  style?: Record<string, unknown>;
  /** Its frame in its parent as it lays out (layout checks in tests). */
  onLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
  children?: JSX.Element;
}) {
  return (
    <View
      role={props.role}
      onLayout={props.onLayout}
      accessibilityLabel={props.accessibilityLabel}
      class={`max-w-full rounded-full border-[0.5px] border-line ${glassClass("nav")} ${props.class ?? ""}`}
      testID={glassEnabled() ? `${props.testID}.glass` : props.testID}
      style={{
        padding: BAR_INSET,
        ...glassStyle(),
        boxShadow: platform.os === "android" ? undefined : BAR_SHADOW,
        ...props.style,
      }}
    >
      {props.children}
    </View>
  );
}
