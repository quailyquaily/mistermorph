// The phone navigation (the Vue console's AppMobileBottomNav, AppMobileBottomMenu and
// AppMobileAgentSwitcher): icons at the foot of the window, the primary pages, More, and the agent,
// in a capsule that floats on the page (the layout of Telegram's tab bar, without its labels;
// design/ui-refresh.html §4). A lighter pill behind the active slot slides to it, and its icon fills.
// More and the agent open the same sheet, over a scrim: a card as wide as the window less the bar's
// side margins, floating above the bar, that slides up from the window's foot; More's lists the
// other pages, the agent's the agents (AgentSwitcher's `AgentList`, the sidebar switcher's rows).
// Escape, Android's Back or a press outside closes either.
import type { JSX } from "nsh";
import { computed, createAnimatedValue, effect, keymap, platform, signal, Text, untracked, View, windowSize } from "nsh";
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
  systemInsets,
  type NavItem,
} from "../../lib/shell";
import { onSystemBack } from "../../lib/systemBack";
import { MOTION_EASE, MOTION_EXIT_EASE, MOTION_SHEET_IN, MOTION_SHEET_OUT, motionMs } from "../motion/tokens";
import defaultEndpointAvatar from "../../assets/images/app_logo_current.svg";
import { Icon, MENU_POPUP_STYLE, POPUP_RADIUS, Tip, TipButton, type IconName } from "../ui";
import { AgentAvatar, AgentList } from "./AgentSwitcher";
import { usePersonaSummary } from "./personaSummary";
import { NavList } from "./Sidebar";
import { uiSlots } from "./slots";
import { BAR_BELOW, BAR_INSET, BAR_SIDE, mobileBarRoom, mobileNavSlots, mobileSheetFrame, MOBILE_NAV_HEIGHT } from "./mobileBar";

export { MOBILE_NAV_HEIGHT };

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

const PRIMARY_PAGE_PATHS = ["/chat", "/contacts", "/todo"];
const BAR_SHADOW = "0 6px 20px rgba(14, 44, 87, 0.10), 0 1px 3px rgba(14, 44, 87, 0.06)";

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

// The sheets slide up from the window's foot, behind the bar, to float above it, and slide back
// down (MOTION_SHEET_IN in, MOTION_SHEET_OUT out on MOTION_EXIT_EASE, as dialogs on phones).
// Reopening one while it slides out turns it round from where it is, as the motion runs from the
// animated value's current position. A closing sheet takes no presses; with reduced motion it
// appears and goes at once.
/** The sheet's title row (min-h-9.5) and its hairline. */
const SHEET_HEADER = 39;

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
}) {
  const shown = signal(untracked(() => props.open));
  const closing = signal(false);
  // 0 hidden below the window's foot, 1 fully risen; the scrim fades with it.
  const progress = createAnimatedValue(0);
  const height = signal(0);
  let generation = 0;

  effect(() => {
    const open = props.open;
    untracked(() => {
      const run = ++generation;
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
      <SheetLayer {...props} closing={closing()} progress={progress} height={height()} onHeight={(value) => height.set(value)} />
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
  /** The sheet's height, which it slides by. */
  height: number;
  onHeight: (height: number) => void;
}) {
  keymap.bind("escape", () => props.onClose());
  // Android's Back closes the sheet before it leaves the page.
  onSystemBack(() => !props.closing, () => props.onClose());
  // The page's height (the layer covers it), the window's until the layer's first layout.
  const room = signal(0);
  const frame = () => mobileSheetFrame(room() || windowSize().height, mobileBarRoom());
  const bottom = () => frame().bottom;
  const sheetMax = () => frame().maxHeight;
  return (
    <View
      class="absolute inset-0 z-40"
      testID={props.closing ? undefined : props.testID}
      onLayout={({ bounds }) => room.set(bounds.size.height)}
      style={props.closing ? { pointerEvents: "none" } : undefined}
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
        class="absolute overflow-hidden border border-line-faint bg-dialog"
        // Until its first layout the sheet's height is unknown: it starts far below, not at 0.
        onLayout={({ bounds }) => {
          props.onHeight(bounds.size.height);
          props.onFrame?.({ x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height });
        }}
        testID={props.testID && !props.closing ? `${props.testID}-sheet` : undefined}
        style={{
          left: frame().side,
          right: frame().side,
          bottom: bottom(),
          maxHeight: sheetMax(),
          borderRadius: POPUP_RADIUS,
          // As the bar: no outer shadow on Android, where it would not follow the corners.
          boxShadow: platform.os === "android" ? undefined : MENU_POPUP_STYLE.boxShadow,
          transform: [
            {
              translateY: props.progress.interpolate({
                inputRange: [0, 1],
                outputRange: [props.height > 0 ? props.height + bottom() + 1 : 4000, 0],
              }),
            },
          ],
        }}
      >
        <View class="min-h-9.5 flex-row items-center gap-2 border-b border-line-soft px-4">
          <View class="size-1.5 bg-muted-foreground" />
          <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground">{props.label}</Text>
        </View>
        {props.children(sheetMax() - SHEET_HEADER - 2)}
      </View>
    </View>
  );
}

/** The More and agent sheets over the page; put them last in the content area so they cover the
 * page, not the strip. `onSheetLayout` hears each sheet's frame in the page ("mobile-more",
 * "mobile-agents"; tests/mobile-bottom-nav.test.tsx). */
export function MobileBottomMenus(props: { onSheetLayout?: (name: string, frame: MobileNavFrame) => void } = {}) {
  const BottomLeft = uiSlots["sidebar.bottom_left"];
  return (
    <>
      <BottomSheet open={mobileMoreOpen()} label={t("nav_more")} onClose={closeMobileMore} testID="mobile-more" onFrame={(frame) => props.onSheetLayout?.("mobile-more", frame)}>
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

/** A frame the strip reports for layout checks (tests/mobile-bottom-nav.test.tsx). */
export type MobileNavFrame = { x: number; y: number; w: number; h: number };

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

  // The capsule holds its slots and no more, centred: each slot has its own stretch of the row,
  // side by side (none reaches under its neighbour, so a press always lands on the slot drawn
  // there), NAV_SLOT_MAX wide where the strip has room and narrower on a narrow phone, so all five
  // fit. The active pill is one slot wide and slides to the slot's place in the same geometry.
  // The strip's own width (the frame it floats in), the window's until its first layout.
  const stripWidth = signal(0);
  const slots = computed(() => mobileNavSlots(stripWidth() || windowSize().width, slotCount()));
  const slotClass = (press = true) =>
    `items-center justify-center rounded-full ${press ? "active:bg-hover-soft transition-colors duration-160" : ""}`;
  const slotStyle = () => ({ width: slots().slot });
  type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };
  const report = (name: string) =>
    props.onSlotLayout
      ? ({ bounds }: LayoutEvent) =>
          props.onSlotLayout?.(name, { x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height })
      : undefined;
  effect(() => {
    const slot = activeSlot();
    const { slot: width, left } = slots();
    if (props.onSlotLayout && slot >= 0) untracked(() => props.onSlotLayout?.("highlight", { x: left(slot), y: 0, w: width, h: MOBILE_NAV_HEIGHT - BAR_INSET * 2 }));
  });

  const tip = (label: string) => <Tip text={label} />;

  return (
    <View
      role="navigation"
      accessibilityLabel={t("mobile_nav")}
      testID="mobile-bottom-nav"
      // The capsule floats over the foot of the page, which scrolls on under it (each page's main
      // list ends with MobileBarSpacer). It sits above the bottom system bar: on Android by the
      // room lib/systemInsets.ts gives it (none while the keyboard is up), elsewhere by the safe
      // area. Only the capsule takes presses; the page shows and works round it.
      class={`absolute bottom-0 left-0 right-0 z-50 items-center ${systemInsets() ? "" : "pb-[env(safe-area-inset-bottom)]"}`}
      onLayout={({ bounds }) => stripWidth.set(bounds.size.width)}
      style={{
        paddingLeft: BAR_SIDE,
        paddingRight: BAR_SIDE,
        paddingBottom: systemInsets() ? systemInsets()!.bottomNav + BAR_BELOW : undefined,
        pointerEvents: "box-none",
      }}
    >
      <View
        class="max-w-full rounded-full border-[0.5px] border-line bg-card/85"
        style={{
          padding: BAR_INSET,
          marginBottom: systemInsets() ? 0 : BAR_BELOW,
          backdropFilter: "blur(20px)",
          boxShadow: platform.os === "android" ? undefined : BAR_SHADOW,
        }}
      >
        <View class="relative flex-row" style={{ width: slots().rowWidth, height: MOBILE_NAV_HEIGHT - BAR_INSET * 2 }}>
          <If when={activeSlot() >= 0}>
            <View
              accessibilityElementsHidden
              class="absolute bottom-0 left-0 top-0 rounded-full bg-blue/10"
              style={{
                width: slots().slot,
                transform: [{ translateX: slots().left(activeSlot()) }],
                transitionProperty: "transform",
                transitionDuration: motionMs(240),
                transitionTimingFunction: "cubic-bezier(0.2, 0.7, 0.2, 1)",
              }}
            />
          </If>
          <Each of={primaryItems()} key={(item) => item.id}>
            {(item, index) => (
              <TipButton
                selected={activeSlot() === index()}
                onPress={() => navigateTo(item())}
                accessibilityLabel={item().title}
                testID={`mobile-nav-${item().pagePath.slice(1)}`}
                tooltip={tip(item().title)}
                class={slotClass()}
                style={slotStyle()}
                onLayout={report(`mobile-nav-${item().pagePath.slice(1)}`)}
              >
                <Icon name={item().icon as IconName} size={24} filled={activeSlot() === index()} color={activeSlot() === index() ? "blue" : "muted-foreground"} />
              </TipButton>
            )}
          </Each>
          <TipButton
            selected={activeSlot() === primaryItems().length}
            onPress={toggleMore}
            accessibilityLabel={moreLabel()}
            testID="mobile-nav-more"
            tooltip={tip(moreLabel())}
            class={slotClass()}
            style={slotStyle()}
            onLayout={report("mobile-nav-more")}
          >
            <Icon name={moreIcon()} size={24} filled={activeSlot() === primaryItems().length} color={activeSlot() === primaryItems().length ? "blue" : "muted-foreground"} />
          </TipButton>
          {/* The portrait alone, as Telegram's profile slot: selecting or pressing it adds nothing to
              it (no ring, no status mark, no press fill); the pill behind it marks it selected, and
              the list shows whether the agent is connected. */}
          <TipButton
            selected={agentMenuOpen()}
            onPress={toggleAgents}
            accessibilityLabel={`${t("nav_agent")}: ${selectedName()}`}
            testID="mobile-nav-agent"
            tooltip={tip(selectedName())}
            class={slotClass(false)}
            style={slotStyle()}
            onLayout={report("mobile-nav-agent")}
          >
            <AgentAvatar image={selectedAvatar()} size={28} />
          </TipButton>
        </View>
      </View>
    </View>
  );
}
