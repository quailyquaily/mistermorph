// The phone navigation (the Vue console's AppMobileBottomNav, AppMobileBottomMenu and
// AppMobileAgentSwitcher): icons at the foot of the window, the primary pages, More, and the agent,
// in a capsule that floats on the page (the layout of Telegram's tab bar, without its labels;
// design/ui-refresh.html §4). A lighter pill behind the active slot slides to it, and its icon fills.
// More and the agent open the same popup, over a scrim: the phone's floating paper
// (design/mobile-popups.md, lib/mobilePopup.ts), which every other popup on phones follows: all
// four corners round, a small gap in from the window's sides and above the bar, sliding up from
// below the window's bottom edge; More's lists the other pages, the agent's the agents
// (AgentSwitcher's `AgentList`, the sidebar switcher's rows). Escape, Android's Back or a press
// outside closes either.
import type { JSX } from "nsh";
import { computed, createAnimatedValue, effect, keyboardFrame, keymap, platform, safeArea, signal, untracked, View, windowSize } from "nsh";
import { translate } from "../../lib/core/context.js";
import {
  closeMobileMore,
  currentPath,
  endpointItems,
  goOverview,
  goTo,
  isNavPathActive,
  mobileMoreOpen,
  navItems,
  selectedEndpointItem,
  setMobileMoreOpen,
  switchEndpoint,
  phoneWorkbenchOpen,
  systemInsets,
  EDGE_TO_EDGE,
  type NavItem,
} from "../../lib/shell";
import { onSystemBack } from "../../lib/systemBack";
import { MOTION_EASE, MOTION_EXIT_EASE, MOTION_SHEET_IN, MOTION_SHEET_OUT, motionMs } from "../motion/tokens";
import defaultEndpointAvatar from "../../assets/images/app_logo_current.svg";
import { mobilePopupEntrance } from "../../lib/mobilePopup";
import { CONTINUOUS } from "../corners";
import { MENU_POPUP_STYLE, POPUP_RADIUS, POPUP_TITLE_HEIGHT, PopupTitle, type IconName } from "../ui";
import { AgentAvatar, AgentList } from "./AgentSwitcher";
import { usePersonaSummary } from "./personaSummary";
import { NavList } from "./Sidebar";
import { uiSlots } from "./slots";
import { CapsuleNav, type CapsuleNavSlot } from "../shared/CapsuleBar";
import { BAR_BELOW, BAR_SIDE, mobileBarRoom, mobileSheetFrame, MOBILE_NAV_HEIGHT } from "./mobileBar";

export { MOBILE_NAV_HEIGHT };

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

const PRIMARY_PAGE_PATHS = ["/chat", "/contacts", "/todo"];

// The agents' sheet; More's state is lib/shell's (navigation closes it).
const agentMenuOpen = signal(false);

function setAgentMenuOpen(open: boolean) {
  if (open) closeMobileMore();
  agentMenuOpen.set(open);
}

function toggleAgents() {
  setAgentMenuOpen(!agentMenuOpen());
}

function toggleMore() {
  if (mobileMoreOpen()) {
    closeMobileMore();
    return;
  }
  agentMenuOpen.set(false);
  setMobileMoreOpen(true);
}

const primaryItems = computed(() =>
  PRIMARY_PAGE_PATHS.map((pagePath) => navItems().find((item) => item.pagePath === pagePath)).filter(
    (item): item is NavItem => Boolean(item),
  ),
);
const moreItems = computed(() =>
  navItems().filter((item) => !item.separator && typeof item.pagePath === "string" && !PRIMARY_PAGE_PATHS.includes(item.pagePath)),
);
const isActive = (item: NavItem) => isNavPathActive(item, currentPath());
const moreCurrentItem = () => moreItems().find((item) => isActive(item)) || null;
const moreActive = () => moreCurrentItem() !== null;

function navigateTo(item: NavItem) {
  closeMobileMore();
  agentMenuOpen.set(false);
  goTo(item, false);
}

// The sheets slide up from below the page's bottom edge to float above the bar, and slide back
// down (MOTION_SHEET_IN in, MOTION_SHEET_OUT out on MOTION_EXIT_EASE, as every popup on phones).
// Reopening one while it slides out turns it round from where it is, as the motion runs from the
// animated value's current position. A closing sheet takes no presses; with reduced motion it
// appears and goes at once.
/** The sheet's title row (min-h-9.5) and its hairline. */
const SHEET_HEADER = POPUP_TITLE_HEIGHT;

/** A sheet floating above the bar, over a scrim; kept until it has slid out. `children` gets the
 * tallest its content may be. */
function BottomSheet(props: {
  open: boolean;
  label: string;
  onClose: () => void;
  testID?: string;
  children: (contentMax: number) => JSX.Element;
  /** Hears the sheet's frame in the page (layout checks). */
  onFrame?: (frame: MobileNavFrame) => void;
  /** For tests: the sheet's progress (0 out of sight below the page, 1 in its place), each time it
   * is told to open or close. */
  onProgress?: (progress: ReturnType<typeof createAnimatedValue>, open: boolean) => void;
}) {
  const shown = signal(untracked(() => props.open));
  const closing = signal(false);
  // 0 hidden below the page's bottom edge, 1 in its place; the scrim fades with it.
  const progress = createAnimatedValue(0);
  const box = signal({ y: 0, height: 0 });
  let generation = 0;

  effect(() => {
    const open = props.open;
    untracked(() => {
      const run = ++generation;
      if (open || shown()) props.onProgress?.(progress, open);
      if (open) {
        closing.set(false);
        if (!shown()) shown.set(true);
        void progress.timing(1, { duration: motionMs(MOTION_SHEET_IN), easing: MOTION_EASE });
      } else if (shown()) {
        closing.set(true);
        void progress.timing(0, { duration: motionMs(MOTION_SHEET_OUT), easing: MOTION_EXIT_EASE }).then(() => {
          if (run === generation) {
            closing.set(false);
            shown.set(false);
          }
        });
      }
    });
  });

  return (
    <If when={shown()}>
      <SheetLayer {...props} closing={closing()} progress={progress} box={box()} onBox={(value) => box.set(value)} />
    </If>
  );
}

function SheetLayer(props: {
  label: string;
  onClose: () => void;
  testID?: string;
  children: (contentMax: number) => JSX.Element;
  onFrame?: (frame: MobileNavFrame) => void;
  closing: boolean;
  progress: ReturnType<typeof createAnimatedValue>;
  /** The sheet's top in the layer and its height: what it slides by. */
  box: { y: number; height: number };
  onBox: (box: { y: number; height: number }) => void;
}) {
  keymap.bind("escape", () => props.onClose());
  // Android's Back closes the sheet before it leaves the page.
  onSystemBack(() => !props.closing, () => props.onClose());
  // The page's size (the layer covers it), the window's until the layer's first layout.
  const room = signal({ width: 0, height: 0 });
  const layerHeight = () => room().height || windowSize().height;
  // The insets the page lies under: Android's frame takes the top and the sides (and stands on the
  // keyboard), so only the bar's room is left there (lib/systemInsets.ts).
  const frame = () =>
    mobileSheetFrame(
      room().width || windowSize().width,
      layerHeight(),
      mobileBarRoom(),
      EDGE_TO_EDGE ? {} : safeArea(),
      EDGE_TO_EDGE ? 0 : keyboardFrame().height,
    );
  const sheetMax = () => frame().maxHeight;
  return (
    <View
      // The paper at the foot of the layer, centred, inside the layer's padding (the frame).
      class="absolute inset-0 z-40 items-center justify-end"
      testID={props.closing ? undefined : props.testID}
      onLayout={({ bounds }) => room.set({ width: bounds.size.width, height: bounds.size.height })}
      style={{
        paddingTop: frame().top,
        paddingRight: frame().right,
        paddingBottom: frame().bottom,
        paddingLeft: frame().left,
        pointerEvents: props.closing ? "none" : undefined,
      }}
    >
      <View
        class="absolute inset-0 bg-scrim"
        accessibilityElementsHidden
        style={{ opacity: props.progress }}
        onPress={() => props.onClose()}
        testID={props.testID && !props.closing ? `${props.testID}-mask` : undefined}
      />
      <View
        role="menu"
        accessibilityLabel={props.label}
        class={`w-full overflow-hidden ${CONTINUOUS} border border-line-faint bg-dialog`}
        // Until its first layout the sheet's place is unknown: it starts a page's height down.
        onLayout={({ bounds }) => {
          props.onBox({ y: bounds.origin.y, height: bounds.size.height });
          props.onFrame?.({
            x: bounds.origin.x,
            y: bounds.origin.y,
            w: bounds.size.width,
            h: bounds.size.height,
            from: mobilePopupEntrance(bounds.origin.y, bounds.size.height, untracked(layerHeight)),
          });
        }}
        testID={props.testID && !props.closing ? `${props.testID}-sheet` : undefined}
        style={{
          maxWidth: frame().maxWidth,
          maxHeight: sheetMax(),
          borderRadius: POPUP_RADIUS,
          // As the bar: no outer shadow on Android, where it would not follow the corners.
          boxShadow: platform.os === "android" ? undefined : MENU_POPUP_STYLE.boxShadow,
          transform: [
            {
              translateY: props.progress.interpolate({
                inputRange: [0, 1],
                outputRange: [mobilePopupEntrance(props.box.y, props.box.height, layerHeight()), 0],
              }),
            },
          ],
        }}
      >
        <PopupTitle label={props.label} />
        {props.children(sheetMax() - SHEET_HEADER - 2)}
      </View>
    </View>
  );
}

/** The More and agent sheets over the page; put them last in the content area so they cover the
 * page, not the strip. `onSheetLayout` hears each sheet's frame in the page ("mobile-more",
 * "mobile-agents"; tests/mobile-bottom-nav.test.tsx), `onSheetProgress` gets each sheet's progress
 * (0 out of sight below the page, 1 in its place: it is `from * (1 - progress)` below its place) each time it is told to open or close. */
export function MobileBottomMenus(
  props: {
    onSheetLayout?: (name: string, frame: MobileNavFrame) => void;
    onSheetProgress?: (name: string, progress: ReturnType<typeof createAnimatedValue>, open: boolean) => void;
  } = {},
) {
  const BottomLeft = uiSlots["sidebar.bottom_left"];
  return (
    <>
      <BottomSheet open={mobileMoreOpen()} label={t("nav_more")} onClose={closeMobileMore} testID="mobile-more" onFrame={(frame) => props.onSheetLayout?.("mobile-more", frame)}
        onProgress={(progress, open) => props.onSheetProgress?.("mobile-more", progress, open)}
      >
        {() => (
          <View class="shrink">
            <NavList items={moreItems()} mobile onNavigate={navigateTo} testPrefix="mobile-more" />
            <If when={BottomLeft}>
              <View class="border-t border-line-soft px-3 pb-3 pt-2">
                {BottomLeft?.({ selectedEndpointItem: selectedEndpointItem(), currentPath: currentPath(), t })}
              </View>
            </If>
          </View>
        )}
      </BottomSheet>
      <BottomSheet open={agentMenuOpen()} label={t("endpoint_switcher_title")} onClose={() => setAgentMenuOpen(false)} testID="mobile-agents"
        onFrame={(frame) => props.onSheetLayout?.("mobile-agents", frame)}
        onProgress={(progress, open) => props.onSheetProgress?.("mobile-agents", progress, open)}
      >
        {(contentMax) => (
          <View class="p-2">
            <AgentList
              items={endpointItems()}
              selectedValue={String(selectedEndpointItem()?.value || "").trim()}
              onSelect={(item) => {
                setAgentMenuOpen(false);
                switchEndpoint(item.value);
              }}
              onOverview={() => {
                setAgentMenuOpen(false);
                goOverview();
              }}
              open={agentMenuOpen()}
              // The sheet's padding (p-2) round it.
              maxHeight={contentMax - 16}
              partID="mobile-agents"
              optionPrefix="mobile-agent-option"
              overviewTestID="mobile-agents-overview"
            />
          </View>
        )}
      </BottomSheet>
    </>
  );
}

/** A frame the strip reports for layout checks (tests/mobile-bottom-nav.test.tsx); a sheet's also
 * says where it slides in from (`from`: its translation while out of sight, below the page). */
export type MobileNavFrame = { x: number; y: number; w: number; h: number; from?: number };

/** The strip itself. `onSlotLayout` hears each slot's frame in the row (by its test id) and the
 * active pill's ("highlight", where its slide puts it). */
export function MobileBottomNav(props: { onSlotLayout?: (name: string, frame: MobileNavFrame) => void } = {}) {
  const { personaAvatarURL } = usePersonaSummary();
  const slotCount = () => primaryItems().length + 2;
  const activeSlot = () => {
    if (agentMenuOpen()) return slotCount() - 1;
    if (mobileMoreOpen()) return primaryItems().length;
    const primaryIndex = primaryItems().findIndex((item) => isActive(item));
    if (primaryIndex >= 0) return primaryIndex;
    return moreActive() ? primaryItems().length : -1;
  };
  const moreIcon = (): IconName => (moreCurrentItem()?.icon as IconName) || "PhSquaresFour";
  const moreLabel = () =>
    moreActive() ? `${moreCurrentItem()?.title} · ${t("nav_more")}` : t("nav_more");


  const selectedName = () => selectedEndpointItem()?.title || t("nav_agent");
  const selectedAvatar = () => personaAvatarURL() || selectedEndpointItem()?.image || defaultEndpointAvatar;

  // The capsule holds its slots and no more, centred (the shared CapsuleNav): each slot has its
  // own stretch of the row, NAV_SLOT_MAX wide where the strip has room and narrower on a narrow
  // phone, so all five fit; the active pill slides to the slot's place in the same geometry.
  // The strip's own width (the frame it floats in), the window's until its first layout.
  const stripWidth = signal(0);
  const AGENT_SLOT = "agent";
  const MORE_SLOT = "more";
  const slots = computed<CapsuleNavSlot[]>(() => [
    ...primaryItems().map((item) => ({ id: item.id, label: item.title, icon: item.icon as IconName, testID: `mobile-nav-${item.pagePath.slice(1)}` })),
    { id: MORE_SLOT, label: moreLabel(), icon: moreIcon(), testID: "mobile-nav-more" },
    // The portrait alone, as Telegram's profile slot: selecting or pressing it adds nothing to it
    // (no ring, no status mark, no press fill); the pill behind it marks it selected, and the list
    // shows whether the agent is connected.
    { id: AGENT_SLOT, label: `${t("nav_agent")}: ${selectedName()}`, glyph: () => <AgentAvatar image={selectedAvatar()} size={28} />, testID: "mobile-nav-agent" },
  ]);
  const activeId = () => {
    const at = activeSlot();
    return at >= 0 ? (slots()[at]?.id ?? null) : null;
  };
  const pressSlot = (id: string) => {
    if (id === AGENT_SLOT) return toggleAgents();
    if (id === MORE_SLOT) return toggleMore();
    const item = primaryItems().find((entry) => entry.id === id);
    if (item) navigateTo(item);
  };

  return (
    <View
      role="navigation"
      accessibilityLabel={t("mobile_nav")}
      testID="mobile-bottom-nav"
      // The capsule floats over the foot of the page, which scrolls on under it (each page's main
      // list ends with MobileBarSpacer). It sits above the bottom system bar: on Android by the
      // room lib/systemInsets.ts gives it (none while the keyboard is up), elsewhere by the safe
      // area; over an open workbench (phones), which takes that inset, by none. Only the capsule
      // takes presses; the page shows and works round it.
      class={`absolute bottom-0 left-0 right-0 z-50 items-center ${systemInsets() || phoneWorkbenchOpen() ? "" : "pb-[env(safe-area-inset-bottom)]"}`}
      onLayout={({ bounds }) => stripWidth.set(bounds.size.width)}
      style={{
        paddingLeft: BAR_SIDE,
        paddingRight: BAR_SIDE,
        paddingBottom: systemInsets() ? systemInsets()!.bottomNav + BAR_BELOW : undefined,
        pointerEvents: "box-none",
      }}
    >
      <CapsuleNav
        slots={slots()}
        active={activeId()}
        onPress={pressSlot}
        width={stripWidth() || windowSize().width}
        testID="mobile-nav-capsule"
        style={{ marginBottom: systemInsets() ? 0 : BAR_BELOW }}
        onSlotLayout={props.onSlotLayout}
      />
    </View>
  );
}
