// The phone navigation (the Vue console's AppMobileBottomNav, AppMobileBottomMenu and
// AppMobileAgentSwitcher): a docked strip of icons at the foot of the window, the primary pages,
// More, and the agent. A short blue rule on the strip's top edge slides to the active slot. More
// and the agent each open a sheet docked on the strip, over a scrim; Escape or the scrim closes it.
import type { JSX } from "nsh";
import { computed, keymap, signal, Text, View } from "nsh";
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
  type NavItem,
} from "../../lib/shell";
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

/** A sheet docked on the strip, rising from behind it, over a scrim. */
function BottomSheet(props: { label: string; onClose: () => void; testID?: string; children?: JSX.Element }) {
  keymap.bind("escape", () => props.onClose());
  return (
    <View class="absolute inset-0 z-40" testID={props.testID}>
      <View
        class="absolute inset-0 bg-scrim"
        accessibilityElementsHidden
        onPress={() => props.onClose()}
        testID={props.testID ? `${props.testID}-mask` : undefined}
      />
      <View
        role="menu"
        accessibilityLabel={props.label}
        class="absolute bottom-0 left-0 right-0 max-h-[62%] border-t border-line bg-card"
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
      <If when={mobileMoreOpen()}>
        <BottomSheet label={t("nav_more")} onClose={closeMobileMore} testID="mobile-more">
          <View class="shrink">
            <NavList items={moreItems()} mobile onNavigate={navigateTo} testPrefix="mobile-more" />
            <If when={BottomLeft}>
              <View class="border-t border-line-soft px-3 pb-3 pt-2">
                {BottomLeft?.({ selectedEndpointItem: selectedEndpointItem(), currentPath: currentPath(), t })}
              </View>
            </If>
          </View>
        </BottomSheet>
      </If>
      <If when={agentMenuOpen()}>
        <BottomSheet label={t("endpoint_switcher_title")} onClose={() => setAgentMenuOpen(false)} testID="mobile-agents">
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
      </If>
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
  const selectedOnline = () => selectedEndpointItem()?.connected === true;
  const selectedAvatar = () => personaAvatarURL() || selectedEndpointItem()?.image || defaultEndpointAvatar;

  const width = signal(0);
  const indicatorLeft = () => {
    const count = slotCount();
    return 4 + ((width() - 8) / count) * (activeSlot() + 0.5) - 14;
  };

  const slotClass = "flex-1 items-center justify-center px-0.5 hover:bg-hover-soft active:bg-hover-soft transition-colors duration-160";
  const tip = (label: string) => <Tip text={label} />;

  return (
    <View
      role="navigation"
      accessibilityLabel={t("mobile_nav")}
      testID="mobile-bottom-nav"
      class="relative z-50 border-t border-line bg-card px-1 pb-[env(safe-area-inset-bottom)]"
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
          class={slotClass}
        >
          <View class="relative size-5.5">
            <View class={`rounded-full ${activeSlot() === slotCount() - 1 ? "border-[1.5px] border-blue" : ""}`}>
              <AgentAvatar image={selectedAvatar()} size={22} />
            </View>
            <View
              class={`absolute -bottom-0.5 -right-0.75 size-2.75 rounded-[1px] border-[1.5px] border-card ${
                selectedOnline() ? "bg-status-on" : "bg-card"
              }`}
            >
              <If when={!selectedOnline()}>
                <View class="size-full rounded-[1px] border border-status-off" />
              </If>
            </View>
          </View>
        </TipButton>
      </View>
    </View>
  );
}
