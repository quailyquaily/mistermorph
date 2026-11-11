// The sidebar of wide windows (the Vue console's AppSidebar, AppSidebarControls and AppNavList):
// the agent switcher, the workspace navigation, the runtime extension slot at its foot, and its
// right edge, which folds it to its icons when dragged (or with the arrow keys while focused).
import { cleanup, effect, keymap, PanResponder, signal, Text, token, View } from "nsh";
import { EdgeScroll } from "../motion/ScrollEdges";
import { Button as BaseButton } from "nsh/base";
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
import { createSlidingSelection } from "../motion/SlidingSelection";
import { BandEdge } from "../motion/Sag";
import { Icon, Tip, TipButton, type IconName } from "../ui";
import defaultEndpointAvatar from "../../assets/images/app_logo_current.svg";
import { AgentSwitcher } from "./AgentSwitcher";
import { usePersonaSummary } from "./personaSummary";
import { uiSlots } from "./slots";
import { SHORTCUT_ACTIONS, shortcutLabel } from "../../lib/shortcuts";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

/** Whether `item` is the page shown (or being opened), or a page below it. */
export function isNavItemActive(item: NavItem) {
  return isNavPathActive(item, currentPath());
}

/** One link of the navigation; folded, its icon with the title as a tooltip. */
export function NavLink(props: {
  item: NavItem;
  collapsed?: boolean;
  onPress: () => void;
  mobile?: boolean;
  testID?: string;
  onLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
}) {
  const active = () => isNavItemActive(props.item);
  // Its keyboard shortcut, in the tooltip (wide windows: the phone's More menu has no keyboard).
  const shortcut = () => {
    const action = props.mobile ? undefined : SHORTCUT_ACTIONS.find((item) => item.page === props.item.pagePath);
    return action ? shortcutLabel(action.id) : "";
  };
  // AppNavList.css: 42pt rows, 14pt sides, a 14pt icon 10pt before a 14pt label in the second ink;
  // the page you are on is ink on the list's highlight (no fill of its own: the sidebar draws its
  // band, which flares into the sidebar's edge), and another row lights up 6 % after a short pause when
  // the pointer rests on it and goes out at once. Every row keeps a hover style, transparent on the
  // current one: a row without one misses the pointer leaving it, and would light up later.
  return (
    <TipButton
      selected={active()}
      onPress={props.onPress}
      onLayout={props.onLayout}
      accessibilityLabel={props.item.title}
      testID={props.testID}
      tooltip={props.collapsed || shortcut() ? <Tip text={props.item.title} shortcut={shortcut()} placement="right" /> : undefined}
      class={`flex-row items-center gap-2.5 ${props.mobile ? "min-h-12 px-4" : "min-h-[42px]"} ${
        props.collapsed ? "justify-center px-0" : props.mobile ? "" : "px-3.5"
      } ${active() ? "hover:bg-transparent focus:bg-transparent" : "hover:bg-hover-soft focus:bg-hover-soft"}`}
      style={{ transitionProperty: "colors", transitionDuration: 160, transitionTimingFunction: "ease" }}
      hoverStyle={{ transitionDelay: 60 }}
    >
      <Icon name={props.item.icon as IconName} size={props.mobile ? 16 : 14} color={active() ? "foreground" : "muted-foreground"} />
      <If when={!props.collapsed}>
        <Text
          class={`flex-1 text-sm font-medium leading-[16.8px] ${active() ? "text-foreground" : "text-subtle"}`}
          style={{ numberOfLines: 1 }}
        >
          {props.item.title}
        </Text>
      </If>
    </TipButton>
  );
}

/** The workspace navigation, with the extension slot before Settings; the page you are on is marked by one highlight that glides between rows. */
export function NavList(props: {
  items: NavItem[];
  collapsed?: boolean;
  mobile?: boolean;
  onNavigate: (item: NavItem) => void;
  testPrefix?: string;
  /** The page's row's centre (y) in the list, or null: where the sidebar draws its band. */
  onActiveCenter?: (y: number | null) => void;
  /** Leave the page's highlight to the caller (the sidebar draws it with its edge). */
  noHighlight?: boolean;
}) {
  const BeforeRuntime = uiSlots["sidebar.before_runtime"];
  const activeId = () => props.items.find((item) => !item.separator && isNavItemActive(item))?.id ?? null;
  const selection = createSlidingSelection(activeId);
  const centers = signal<Record<string, number>>({});
  const track = (id: string) => {
    const tracked = selection.track(id);
    return (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => {
      tracked(event);
      const y = event.bounds.origin.y + event.bounds.size.height / 2;
      if (centers()[id] !== y) centers.set({ ...centers(), [id]: y });
    };
  };
  if (props.onActiveCenter) {
    effect(() => {
      const id = activeId();
      props.onActiveCenter?.(id ? centers()[id] ?? null : null);
    });
  }
  return (
    <View class={`relative ${props.mobile ? "py-1" : "pb-3 pt-2"}`}>
      <If when={!props.noHighlight}>
        <selection.Highlight class="bg-selection" testID={`${props.testPrefix ?? "nav"}-selection`} />
      </If>
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <If
            when={!item().separator}
            else={<View class={`h-px bg-line-soft ${props.collapsed ? "ml-2.5 my-3" : props.mobile ? "my-2" : "ml-3.5 my-3"}`} />}
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
              onLayout={track(item().id)}
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
      tooltip={<Tip text={label()} shortcut={shortcutLabel("frame.toggleSidebar")} placement="right" />}
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
        class={`w-0.5 transition-colors duration-160 group-hover:bg-edge group-focus:bg-edge ${sidebarDragWidth() !== null ? "bg-edge" : ""}`}
      />
    </View>
  );
}

/** A navigation row's height in the sidebar (NavLink's `min-h-[42px]`). */
const NAV_ROW = 42;

export function Sidebar() {
  const { personaAvatarURL, personaName } = usePersonaSummary();
  const BottomLeft = uiSlots["sidebar.bottom_left"];
  const collapsed = () => sidebarShowsCollapsed();
  // The page's row's band is drawn with the sidebar's edge (design/ui-refresh.html §2), so it runs
  // right up to the edge and flares into it: placed at the row's centre in the list, moved by where
  // the list sits in the sidebar and how far it has scrolled; none while the row is out of sight.
  const rowCenter = signal<number | null>(null);
  const listTop = signal(0);
  const listHeight = signal(0);
  const scrollY = signal(0);
  const edgeCenter = () => {
    const row = rowCenter();
    if (row === null) return null;
    const y = row - scrollY();
    return y < 0 || y > listHeight() ? null : listTop() + y;
  };
  return (
    <View
      class="relative z-10 select-none"
      style={{ width: sidebarWidth() }}
      accessibilityLabel={t("mobile_nav")}
      testID="sidebar"
    >
      {/* The sidebar's fill, its right edge and the active row's band are one drawing, so the band
          reaches the edge and flares into it. */}
      <BandEdge
        center={edgeCenter}
        band={{ size: NAV_ROW, color: String(token("selection")) }}
        fill={String(token("nav"))}
        line={String(token("line-soft"))}
        class="absolute inset-0"
      />
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
      <View
        class="flex-1"
        onLayout={({ bounds }) => {
          listTop.set(bounds.origin.y);
          listHeight.set(bounds.size.height);
        }}
      >
        <EdgeScroll class="flex-1" onScroll={(event) => scrollY.set(event.offset.y)}>
          <NavList
            items={navItems()}
            collapsed={collapsed()}
            onNavigate={(item) => goTo(item)}
            onActiveCenter={(y) => rowCenter.set(y)}
            noHighlight
          />
        </EdgeScroll>
      </View>
      <If when={BottomLeft && !collapsed()}>
        <View class="p-3">
          {BottomLeft?.({ selectedEndpointItem: selectedEndpointItem(), currentPath: currentPath(), t })}
        </View>
      </If>
      <SidebarEdge />
    </View>
  );
}
