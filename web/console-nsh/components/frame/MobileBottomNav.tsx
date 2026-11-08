// The phone navigation (the Vue console's AppMobileBottomNav, AppMobileBottomMenu and
// AppMobileAgentSwitcher): a docked strip of icons at the foot of the window, the primary pages,
// More, and the agent. A short blue rule on the strip's top edge slides to the active slot. More
// and the agent each open a sheet docked on the strip, over a scrim; Escape, Android's Back or the
// scrim closes it.
import type { JSX } from "nsh";
import { computed, createAnimatedValue, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
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
import { MOTION_EASE, motionMs } from "../motion/tokens";
import defaultEndpointAvatar from "../../assets/images/app_logo_current.svg";
import { Icon, TextField, Tip, TipButton, type IconName } from "../ui";
import { AgentAvatar, AgentOptionList, filterAgentItems, normalizeAgentItems, OverviewRow } from "./AgentSwitcher";
import { usePersonaSummary } from "./personaSummary";
import { NavList } from "./Sidebar";
import { uiSlots } from "./slots";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

const PRIMARY_PAGE_PATHS = ["/chat", "/contacts", "/todo"];
/** The strip's height, without the bottom safe area and its 1pt top hairline (`--mobile-nav-height` 52, border-box). */
export const MOBILE_NAV_HEIGHT = 51;

// The agent sheet; More's state is lib/shell's (navigation closes it).
const agentMenuOpen = signal(false);
const agentFilter = signal("");

function setAgentMenuOpen(open: boolean) {
  if (open) {
    closeMobileMore();
    agentFilter.set("");
  }
  agentMenuOpen.set(open);
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

// The sheets rise from behind the strip and sink back into it (the Vue console's 280ms in, 200ms
// out). Reopening one while it sinks turns it round from where it is, as the motion runs from the
// animated value's current position. A closing sheet takes no presses; with reduced motion it
// appears and goes at once.
const SHEET_IN_MS = 280;
const SHEET_OUT_MS = 200;
const SHEET_OUT_EASE: [number, number, number, number] = [0.4, 0, 1, 1];

/** A sheet docked on the strip, rising from behind it, over a scrim; kept until it has sunk back. */
function BottomSheet(props: { open: boolean; label: string; onClose: () => void; testID?: string; children?: JSX.Element }) {
  const shown = signal(untracked(() => props.open));
  const closing = signal(false);
  // 0 hidden behind the strip, 1 fully risen; the scrim fades with it.
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
        void progress.timing(1, { duration: motionMs(SHEET_IN_MS), easing: MOTION_EASE });
      } else if (shown()) {
        closing.set(true);
        void progress.timing(0, { duration: motionMs(SHEET_OUT_MS), easing: SHEET_OUT_EASE }).then(() => {
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
  children?: JSX.Element;
  closing: boolean;
  progress: ReturnType<typeof createAnimatedValue>;
  /** The sheet's height, which it rises by. */
  height: number;
  onHeight: (height: number) => void;
}) {
  keymap.bind("escape", () => props.onClose());
  // Android's Back closes the sheet before it leaves the page.
  onSystemBack(() => !props.closing, () => props.onClose());
  return (
    <View class="absolute inset-0 z-40" testID={props.closing ? undefined : props.testID} style={props.closing ? { pointerEvents: "none" } : undefined}>
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
        class="absolute bottom-0 left-0 right-0 max-h-[62%] border-t border-line bg-card"
        // Until its first layout the sheet's height is unknown: it starts far below, not at 0.
        onLayout={({ bounds }) => props.onHeight(bounds.size.height)}
        style={{
          transform: [{ translateY: props.progress.interpolate({ inputRange: [0, 1], outputRange: [props.height > 0 ? props.height + 1 : 4000, 0] }) }],
        }}
      >
        <View class="min-h-9.5 flex-row items-center gap-2 border-b border-line-soft px-4">
          <View class="size-1.5 bg-muted-foreground" />
          <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground">{props.label}</Text>
        </View>
        {props.children}
      </View>
    </View>
  );
}

/** The sheets over the page; put it last in the content area so they cover the page, not the strip. */
export function MobileBottomMenus() {
  const BottomLeft = uiSlots["sidebar.bottom_left"];
  const items = computed(() => normalizeAgentItems(endpointItems()));
  const showFilter = () => items().length > 8;
  const filtered = () => filterAgentItems(items(), agentFilter());
  return (
    <>
      <BottomSheet open={mobileMoreOpen()} label={t("nav_more")} onClose={closeMobileMore} testID="mobile-more">
        <View class="shrink">
          <NavList items={moreItems()} mobile onNavigate={navigateTo} testPrefix="mobile-more" />
          <If when={BottomLeft}>
            <View class="border-t border-line-soft px-3 pb-3 pt-2">
              {BottomLeft?.({ selectedEndpointItem: selectedEndpointItem(), currentPath: currentPath(), t })}
            </View>
          </If>
        </View>
      </BottomSheet>
      <BottomSheet open={agentMenuOpen()} label={t("endpoint_switcher_title")} onClose={() => setAgentMenuOpen(false)} testID="mobile-agents">
        <If when={showFilter()}>
          <TextField
            class="mx-2.5 mb-2 mt-1"
            value={agentFilter()}
            onChange={(value) => agentFilter.set(String(value || ""))}
            placeholder={t("endpoint_switcher_filter_placeholder")}
            testID="mobile-agents-filter"
          />
        </If>
        <View class="shrink">
          <AgentOptionList
            items={filtered()}
            selectedValue={String(selectedEndpointItem()?.value || "").trim()}
            rowClass="min-h-12 px-4"
            testPrefix="mobile-agent-option"
            onSelect={(item) => {
              if (!item.connected) return;
              setAgentMenuOpen(false);
              switchEndpoint(item.value);
            }}
          />
        </View>
        <OverviewRow
          class="min-h-12 px-4"
          testID="mobile-agents-overview"
          onPress={() => {
            setAgentMenuOpen(false);
            goOverview();
          }}
        />
      </BottomSheet>
    </>
  );
}

/** The strip itself. */
export function MobileBottomNav() {
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

  const width = signal(0);
  const indicatorLeft = () => {
    const count = slotCount();
    return 4 + ((width() - 8) / count) * (activeSlot() + 0.5) - 14;
  };

  const slotClass = "flex-1 items-center justify-center px-0.5 hover:bg-hover-soft active:bg-hover-soft transition-colors duration-160";
  const agentSlotClass = "flex-1 items-center justify-center px-0.5";
  const tip = (label: string) => <Tip text={label} />;

  return (
    <View
      role="navigation"
      accessibilityLabel={t("mobile_nav")}
      testID="mobile-bottom-nav"
      // Its card runs under the bottom system bar: on Android by the room lib/systemInsets.ts gives
      // it (none while the keyboard is up), elsewhere by the safe area.
      class={`relative z-50 border-t border-line bg-card px-1 ${systemInsets() ? "" : "pb-[env(safe-area-inset-bottom)]"}`}
      style={systemInsets() ? { paddingBottom: systemInsets()!.bottomNav } : undefined}
      onLayout={({ bounds }) => width.set(bounds.size.width)}
    >
      <If when={activeSlot() >= 0 && width() > 0}>
        <View
          accessibilityElementsHidden
          class="absolute left-0 -top-px h-0.5 w-7 bg-blue"
          style={{
            transform: [{ translateX: indicatorLeft() }],
            transitionProperty: "transform",
            transitionDuration: 220,
            transitionTimingFunction: "ease-out",
          }}
        />
      </If>
      <View class="flex-row" style={{ height: MOBILE_NAV_HEIGHT }}>
        <Each of={primaryItems()} key={(item) => item.id}>
          {(item, index) => (
            <TipButton
              selected={activeSlot() === index()}
              onPress={() => navigateTo(item())}
              accessibilityLabel={item().title}
              testID={`mobile-nav-${item().pagePath.slice(1)}`}
              tooltip={tip(item().title)}
              class={slotClass}
            >
              <Icon name={item().icon as IconName} size={22} color={activeSlot() === index() ? "blue" : "muted-foreground"} />
            </TipButton>
          )}
        </Each>
        <TipButton
          selected={activeSlot() === primaryItems().length}
          onPress={toggleMore}
          accessibilityLabel={moreLabel()}
          testID="mobile-nav-more"
          tooltip={tip(moreLabel())}
          class={slotClass}
        >
          <Icon name={moreIcon()} size={22} color={activeSlot() === primaryItems().length ? "blue" : "muted-foreground"} />
        </TipButton>
        <TipButton
          selected={activeSlot() === slotCount() - 1}
          onPress={() => setAgentMenuOpen(!agentMenuOpen())}
          accessibilityLabel={`${t("nav_agent")}: ${selectedName()}`}
          testID="mobile-nav-agent"
          tooltip={tip(selectedName())}
          class={agentSlotClass}
        >
          {/* The portrait alone: selecting or pressing the slot adds nothing to it (no ring, no
              status mark, no press fill); the top rule marks it selected, and the switcher's list
              shows whether the agent is connected. */}
          <AgentAvatar image={selectedAvatar()} size={22} />
        </TipButton>
      </View>
    </View>
  );
}
