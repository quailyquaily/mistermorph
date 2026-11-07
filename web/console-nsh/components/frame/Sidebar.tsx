// The sidebar of wide windows (the Vue console's AppSidebar, AppSidebarControls and AppNavList):
// the agent switcher, the workspace navigation, the runtime extension slot at its foot, and its
// right edge, which folds it to its icons when dragged (or with the arrow keys while focused).
import { cleanup, keymap, PanResponder, Scroll, Text, View } from "nsh";
import { Button as BaseButton, Tooltip } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import {
  currentPath,
  isNavPathActive,
  endpointItems,
  endSidebarDrag,
  goOverview,
  goTo,
  moveSidebarDrag,
  navItems,
  selectedEndpointItem,
  setSidebarCollapsed,
  sidebarCollapsed,
  sidebarDragWidth,
  sidebarShowsCollapsed,
  sidebarWidth,
  startSidebarDrag,
  switchEndpoint,
  type NavItem,
} from "../../lib/shell";
import { Icon, type IconName } from "../ui";
import defaultEndpointAvatar from "../../assets/images/app_logo_current.svg";
import { AgentSwitcher } from "./AgentSwitcher";
import { usePersonaSummary } from "./personaSummary";
import { uiSlots } from "./slots";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

/** Whether `item` is the page shown (or being opened), or a page below it. */
export function isNavItemActive(item: NavItem) {
  return isNavPathActive(item, currentPath());
}

/** One link of the navigation; folded, its icon with the title as a tooltip. */
export function NavLink(props: { item: NavItem; collapsed?: boolean; onPress: () => void; mobile?: boolean; testID?: string }) {
  const active = () => isNavItemActive(props.item);
  return (
    <BaseButton
      selected={active()}
      onPress={props.onPress}
      accessibilityLabel={props.item.title}
      testID={props.testID}
      tooltip={
        props.collapsed ? (
          <Tooltip class="bg-foreground px-2 py-1">
            <Text class="text-xs text-background">{props.item.title}</Text>
          </Tooltip>
        ) : undefined
      }
      class={`flex-row items-center gap-2.5 ${props.mobile ? "min-h-12 px-4 border-l-2 border-transparent selected:border-blue" : "min-h-10.5"} ${
        props.collapsed ? "justify-center px-0" : props.mobile ? "" : "px-3.5"
      } hover:bg-hover focus:bg-hover selected:bg-selection`}
    >
      <Icon name={props.item.icon as IconName} size={props.mobile ? 16 : 14} color={active() ? "foreground" : "muted-foreground"} />
      <If when={!props.collapsed}>
        <Text class={`flex-1 text-sm line-clamp-1 ${active() ? "font-semibold text-foreground" : "font-medium text-subtle"}`}>
          {props.item.title}
        </Text>
      </If>
    </BaseButton>
  );
}

/** The workspace navigation, with the extension slot before Settings. */
export function NavList(props: {
  items: NavItem[];
  collapsed?: boolean;
  mobile?: boolean;
  onNavigate: (item: NavItem) => void;
  testPrefix?: string;
}) {
  const BeforeRuntime = uiSlots["sidebar.before_runtime"];
  return (
    <View class={props.mobile ? "py-1" : "pb-3 pt-2"}>
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <If
            when={!item().separator}
            else={<View class={`h-px bg-line-soft ${props.collapsed ? "mx-2.5 my-3" : props.mobile ? "my-2" : "mx-3.5 my-3"}`} />}
          >
            <If when={BeforeRuntime && !props.collapsed && item().pagePath === "/settings"}>
              {BeforeRuntime?.({
                selectedEndpointItem: selectedEndpointItem(),
                currentPath: currentPath(),
                mobile: props.mobile,
                t,
              })}
            </If>
            <NavLink
              item={item()}
              collapsed={props.collapsed}
              mobile={props.mobile}
              onPress={() => props.onNavigate(item())}
              testID={`${props.testPrefix ?? "nav"}-${item().pagePath.slice(1)}`}
            />
          </If>
        )}
      </Each>
    </View>
  );
}

/**
 * The sidebar's right edge: drag it to fold or unfold the sidebar. A press on it (or Enter and
 * Space while it has the focus) toggles it, and the arrow keys fold (left) and unfold (right).
 */
function SidebarEdge() {
  const label = () => (sidebarCollapsed() ? t("sidebar_expand") : t("sidebar_collapse"));
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => startSidebarDrag(),
    onPanResponderMove: (_event, gesture) => moveSidebarDrag(gesture.dx),
    onPanResponderRelease: () => endSidebarDrag(),
    onPanResponderTerminate: () => endSidebarDrag(),
  });
  let unbind: (() => void) | null = null;
  const stopKeys = () => {
    unbind?.();
    unbind = null;
  };
  cleanup(() => {
    stopKeys();
    endSidebarDrag();
  });
  return (
    <View
      {...pan.panHandlers}
      role="adjustable"
      focusable
      accessibilityLabel={label()}
      testID="sidebar-edge"
      tooltip={
        <Tooltip class="bg-foreground px-2 py-1">
          <Text class="text-xs text-background">{label()}</Text>
        </Tooltip>
      }
      onFocus={() => {
        stopKeys();
        unbind = keymap.bind({
          left: () => setSidebarCollapsed(true),
          right: () => setSidebarCollapsed(false),
          enter: () => setSidebarCollapsed(!sidebarCollapsed()),
          space: () => setSidebarCollapsed(!sidebarCollapsed()),
        });
      }}
      onBlur={stopKeys}
      onPress={() => setSidebarCollapsed(!sidebarCollapsed())}
      class="group absolute bottom-0 right-0 top-0 w-1.5 flex-row justify-end"
      style={{ cursor: "col-resize" }}
    >
      <View
        class={`w-0.5 group-hover:bg-blue-light group-focus:bg-blue-light ${sidebarDragWidth() !== null ? "bg-blue-light" : ""}`}
      />
    </View>
  );
}

export function Sidebar() {
  const { personaAvatarURL, personaName } = usePersonaSummary();
  const BottomLeft = uiSlots["sidebar.bottom_left"];
  const collapsed = () => sidebarShowsCollapsed();
  return (
    <View
      class="relative z-10 border-r border-line-soft bg-sidebar"
      style={{ width: sidebarWidth() }}
      accessibilityLabel={t("mobile_nav")}
      testID="sidebar"
    >
      <AgentSwitcher
        items={endpointItems()}
        selectedItem={selectedEndpointItem()}
        selectedAvatar={personaAvatarURL() || selectedEndpointItem()?.image || defaultEndpointAvatar}
        selectedName={personaName() || selectedEndpointItem()?.title || t("endpoint_placeholder")}
        placeholder={t("endpoint_placeholder")}
        compact={collapsed()}
        onChange={(item) => switchEndpoint(item.value)}
        onOverview={goOverview}
      />
      <Scroll class="flex-1">
        <NavList items={navItems()} collapsed={collapsed()} onNavigate={(item) => goTo(item)} />
      </Scroll>
      <If when={BottomLeft && !collapsed()}>
        <View class="p-3">
          {BottomLeft?.({ selectedEndpointItem: selectedEndpointItem(), currentPath: currentPath(), t })}
        </View>
      </If>
      <SidebarEdge />
    </View>
  );
}
