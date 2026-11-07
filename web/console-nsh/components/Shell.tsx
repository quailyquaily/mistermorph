// The frame around workspace pages: the sidebar (agent switcher, navigation, collapse) on wide
// windows, the bottom navigation on narrow ones, and the notice stack over everything.
import type { JSX } from "nsh";
import { Image, Scroll, Text, View } from "nsh";
import { Button as BaseButton, Menu, MenuItem, MenuSeparator } from "nsh/base";
import { translate as t } from "../lib/core/context.js";
import { usePersonaStore } from "../lib/stores/personaStore.js";
import {
  currentPath,
  endpointItems,
  goSettings,
  goTo,
  isMobile,
  mobileBottomNavVisible,
  navItems,
  selectedEndpointItem,
  setSidebarCollapsed,
  sidebarCollapsed,
  switchEndpoint,
  type NavItem,
} from "../lib/shell";
import { navigate } from "../lib/router";
import { ConfirmHost, Icon, NoticeHost, StatusMark, type IconName } from "./ui";
import defaultEndpointAvatar from "../assets/images/app_logo_current.svg";

function isActive(item: NavItem) {
  const path = currentPath();
  return path === item.id || path.startsWith(`${item.id}/`);
}

/** The selected agent, and a menu to switch to another or open the overview. */
function AgentSwitcher(props: { compact: boolean }) {
  const persona = usePersonaStore();
  const avatar = () => persona.avatarURL || selectedEndpointItem()?.image || defaultEndpointAvatar;
  const name = () => persona.name || selectedEndpointItem()?.title || t("endpoint_placeholder");
  return (
    <Menu
      placement="bottom"
      align="start"
      popupClass="min-w-56 rounded-(--radius) border border-border bg-popover py-1 shadow-md"
      trigger={
        <View
          role="button"
          accessibilityLabel={name()}
          class={`flex-row items-center gap-2 rounded-(--radius) p-1.5 hover:bg-hover active:bg-selection ${
            props.compact ? "justify-center" : ""
          }`}
        >
          <Image src={avatar()} class="size-7 rounded-full bg-card" style={{ objectFit: "cover" }} />
          <If when={!props.compact}>
            <Text class="flex-1 text-sm font-medium text-foreground line-clamp-1">
              {name()}
            </Text>
            <Icon name="PhCaretDown" size={12} color="muted-foreground" />
          </If>
        </View>
      }
    >
      <Each of={endpointItems()} key={(item) => item.value}>
        {(item) => (
          <MenuItem
            disabled={!item().connected}
            checked={item().value === selectedEndpointItem()?.value}
            onSelect={() => switchEndpoint(item().value)}
            class="flex-row items-center gap-2 px-3 py-1.5 hover:bg-hover disabled:opacity-45"
          >
            <Image src={item().image} class="size-5 rounded-full bg-card" style={{ objectFit: "cover" }} />
            <Text class="flex-1 text-sm text-foreground line-clamp-1">
              {item().title}
            </Text>
            <StatusMark state={item().connected ? "on" : "off"} />
          </MenuItem>
        )}
      </Each>
      <MenuSeparator class="my-1 h-px bg-line-faint" />
      <MenuItem onSelect={() => void navigate("/overview")} class="flex-row items-center gap-2 px-3 py-1.5 hover:bg-hover">
        <Icon name="PhSquaresFour" size={15} color="subtle" />
        <Text class="text-sm text-foreground">{t("nav_overview")}</Text>
      </MenuItem>
      <MenuItem onSelect={goSettings} class="flex-row items-center gap-2 px-3 py-1.5 hover:bg-hover">
        <Icon name="PhGearSix" size={15} color="subtle" />
        <Text class="text-sm text-foreground">{t("nav_settings")}</Text>
      </MenuItem>
    </Menu>
  );
}

function NavButton(props: { item: NavItem; compact: boolean }) {
  return (
    <BaseButton
      selected={isActive(props.item)}
      onPress={() => goTo(props.item)}
      accessibilityLabel={props.item.title}
      testID={`nav-${props.item.pagePath.slice(1)}`}
      tooltip={undefined}
      class={`flex-row items-center gap-2.5 rounded-(--radius) px-2.5 py-1.5 hover:bg-hover selected:bg-selection ${
        props.compact ? "justify-center px-0" : ""
      }`}
    >
      <Icon name={props.item.icon as IconName} size={17} color={isActive(props.item) ? "blue-dark" : "subtle"} />
      <If when={!props.compact}>
        <Text class={`flex-1 text-sm ${isActive(props.item) ? "font-medium text-foreground" : "text-subtle"} line-clamp-1`}>
          {props.item.title}
        </Text>
      </If>
    </BaseButton>
  );
}

function Sidebar() {
  const compact = () => sidebarCollapsed();
  return (
    <View class={`border-r border-line-faint bg-sidebar py-4 ${compact() ? "w-13 px-1.5" : "w-50 px-2.5"} gap-3`}>
      <AgentSwitcher compact={compact()} />
      <Scroll class="flex-1" contentClass="gap-0.5">
        <Each of={navItems()} key={(item) => item.id}>
          {(item) => (
            <If when={!item().separator} else={<View class="mx-2 my-2 h-px bg-line-faint" />}>
              <NavButton item={item()} compact={compact()} />
            </If>
          )}
        </Each>
      </Scroll>
      <BaseButton
        onPress={() => setSidebarCollapsed(!compact())}
        accessibilityLabel={compact() ? t("sidebar_expand") : t("sidebar_collapse")}
        class={`flex-row items-center gap-2 rounded-(--radius) px-2.5 py-1.5 hover:bg-hover ${compact() ? "justify-center px-0" : ""}`}
      >
        <Icon name="PhSidebarSimple" size={16} color="muted-foreground" />
        <If when={!compact()}>
          <Text class="text-xs text-muted-foreground">{t("sidebar_collapse")}</Text>
        </If>
      </BaseButton>
    </View>
  );
}

/** The phone navigation: the main pages, and the rest under More. */
function MobileBottomNav() {
  const primary = () => navItems().filter((item) => !item.separator).slice(0, 4);
  const more = () => navItems().filter((item) => !item.separator).slice(4);
  return (
    <View class="flex-row items-stretch border-t border-line-faint bg-sidebar pb-[env(safe-area-inset-bottom)]">
      <Each of={primary()} key={(item) => item.id}>
        {(item) => (
          <BaseButton
            selected={isActive(item())}
            onPress={() => goTo(item(), false)}
            accessibilityLabel={item().title}
            class="flex-1 items-center gap-0.5 py-2 selected:bg-selection"
          >
            <Icon name={item().icon as IconName} size={20} color={isActive(item()) ? "blue-dark" : "subtle"} />
            <Text class={`text-xs ${isActive(item()) ? "text-foreground" : "text-subtle"}`}>{item().title}</Text>
          </BaseButton>
        )}
      </Each>
      <Menu
        placement="top"
        align="end"
        popupClass="min-w-52 rounded-(--radius) border border-border bg-popover py-1 shadow-md"
        trigger={
          <View role="button" accessibilityLabel={t("nav_more")} class="flex-1 items-center gap-0.5 py-2">
            <Icon name="PhDotsThree" size={20} color="subtle" />
            <Text class="text-xs text-subtle">{t("nav_more")}</Text>
          </View>
        }
      >
        <Each of={more()} key={(item) => item.id}>
          {(item) => (
            <MenuItem onSelect={() => goTo(item(), false)} class="flex-row items-center gap-2 px-3 py-2 hover:bg-hover">
              <Icon name={item().icon as IconName} size={16} color="subtle" />
              <Text class="text-sm text-foreground">{item().title}</Text>
            </MenuItem>
          )}
        </Each>
        <MenuSeparator class="my-1 h-px bg-line-faint" />
        <Each of={endpointItems()} key={(item) => item.value}>
          {(item) => (
            <MenuItem
              disabled={!item().connected}
              checked={item().value === selectedEndpointItem()?.value}
              onSelect={() => switchEndpoint(item().value)}
              class="flex-row items-center gap-2 px-3 py-2 hover:bg-hover disabled:opacity-45"
            >
              <Image src={item().image} class="size-5 rounded-full bg-card" style={{ objectFit: "cover" }} />
              <Text class="flex-1 text-sm text-foreground">{item().title}</Text>
            </MenuItem>
          )}
        </Each>
      </Menu>
    </View>
  );
}

/** The frame: shellless pages fill the window; workspace pages get the sidebar or bottom nav. */
export function Shell(props: { shellless: boolean; standalone: boolean; children?: JSX.Element }) {
  return (
    <View class="flex-1 bg-background">
      <If when={!props.shellless && !props.standalone && !isMobile()} else={<View class="flex-1">{props.children}</View>}>
        <View class="flex-1 flex-row">
          <Sidebar />
          <View class="flex-1">{props.children}</View>
        </View>
      </If>
      <If when={mobileBottomNavVisible()}>
        <MobileBottomNav />
      </If>
      <NoticeHost />
      <ConfirmHost />
    </View>
  );
}
