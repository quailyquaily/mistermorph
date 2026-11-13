// The agent switcher at the top of the sidebar (the Vue console's AgentSwitcher): the selected
// agent's avatar and name; pressed, the agents in the composer's popover bubble (PopoverPicker),
// opening below with its tail up to the switcher: online agents first, offline ones dimmed and not
// selectable, the current one marked, and a last row to the overview of every agent. With more than
// eight agents a filter heads the list. Folded, the sidebar shows the avatar only. The phone's
// bottom bar shows the same rows on a sheet that rises over the page (MobileBottomNav, `AgentList`).
//
// Why not nsh's Menu: on the desktop app (GPUI) the menu's agent rows took no clicks while its
// Overview row did. The rows were in a `Scroll` inside the menu's popup, and under the console's
// scroll bar theme (`Scrollbar.setTheme(SCROLLBAR)`, App.tsx) that scroll view's built-in hover bar
// left every item in it unclickable there; Overview, outside the scroll view, worked. Chrome and the
// headless tests never showed it.
import type { ImageAsset, JSX } from "nsh";
import { computed, Image, signal, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import type { EndpointItem } from "../../lib/shell";
import { FadeText } from "../motion/FadeText";
import { PickerList, PopoverPicker, type PickerItem, type PickerSide } from "../shared/PopoverPicker";
import { Icon, Tip, trackPopup } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

export interface AgentOption {
  value: string;
  title: string;
  image: string | ImageAsset;
  connected: boolean;
}

/** The items as the switchers list them: trimmed, titled, without the ones that have no ref. */
export function normalizeAgentItems(items: EndpointItem[]): AgentOption[] {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const value = normalizeText(item?.value);
      const image = typeof item?.image === "string" ? normalizeText(item.image) : item?.image;
      return {
        value,
        title: normalizeText(item?.title) || value,
        image: image || "",
        connected: item?.connected === true,
      };
    })
    .filter((item) => item.value);
}

/** A round avatar, or an empty disc when there is none. */
export function AgentAvatar(props: { image: string | ImageAsset; size: number; dim?: boolean }) {
  return (
    <If
      when={props.image}
      else={<View class="rounded-full bg-line-soft" style={{ width: props.size, height: props.size }} />}
    >
      {/* In a clipped frame of its size: nsh's web runtime counted the image's own pixels (a 512px
          avatar) into a scroll view's content, so the agent list scrolled far past its rows. */}
      <View class="overflow-hidden rounded-full" style={{ width: props.size, height: props.size }}>
        <Image
          src={props.image}
          class="rounded-full bg-card"
          accessibilityElementsHidden
          style={{ width: props.size, height: props.size, objectFit: "cover", opacity: props.dim ? 0.7 : 1 }}
        />
      </View>
    </If>
  );
}

/** The square connection mark: filled online, hollow offline. */
export function ConnectionMark(props: { online: boolean; class?: string }) {
  return (
    <View
      accessibilityElementsHidden
      class={`size-2 rounded-[1px] border ${props.online ? "border-status-on bg-status-on" : "border-status-off"} ${props.class ?? ""}`}
    />
  );
}

/** The overview row's value: no agent's (refs are trimmed, so none starts with a space). */
export const OVERVIEW_VALUE = " overview";

/**
 * The agents as the picker's rows: online first, then offline ones (disabled, after a hairline when
 * both are there), each with its avatar and connection mark; the filter matches the title or ref.
 */
export function agentPickerItems(items: AgentOption[], testPrefix: string): PickerItem[] {
  const online = items.filter((item) => item.connected);
  const offline = items.filter((item) => !item.connected);
  const row = (item: AgentOption, separated: boolean): PickerItem => ({
    value: item.value,
    title: item.title,
    keywords: item.value,
    disabled: !item.connected,
    separated,
    testID: `${testPrefix}-${item.value}`,
    icon: <AgentAvatar image={item.image} size={24} dim={!item.connected} />,
    trailing: (
      <View class="w-3.5 items-center">
        <ConnectionMark online={item.connected} />
      </View>
    ),
  });
  return [...online.map((item) => row(item, false)), ...offline.map((item, index) => row(item, index === 0 && online.length > 0))];
}

/** The overview row under the agents. */
export function overviewPickerItem(testID: string): PickerItem {
  return {
    value: OVERVIEW_VALUE,
    title: t("nav_overview"),
    testID,
    icon: (
      <View class="w-6 items-center">
        <Icon name="PhNetwork" size={15} color="muted-foreground" />
      </View>
    ),
    trailing: <Icon name="PhCaretRight" size={14} color="muted-foreground" />,
  };
}

/** A row picked in either list: the overview row hears `onOverview`, an online agent `onSelect`. */
function chooseAgent(items: AgentOption[], value: string, onSelect: (item: AgentOption) => void, onOverview: () => void) {
  if (value === OVERVIEW_VALUE) {
    onOverview();
    return;
  }
  const item = items.find((entry) => entry.value === value);
  if (item?.connected) onSelect(item);
}

/**
 * The agents in the popover bubble, for the sidebar's switcher: picking an online agent hears
 * `onSelect`, the overview row `onOverview`; both close it.
 */
export function AgentPicker(props: {
  items: EndpointItem[];
  selectedValue: string;
  onSelect: (item: AgentOption) => void;
  onOverview: () => void;
  trigger: (state: { open: boolean }) => JSX.Element;
  accessibilityLabel: string;
  tooltip?: JSX.Element | false;
  placement: PickerSide;
  align: "start" | "center" | "end";
  clearance?: { top?: number; bottom?: number };
  gap?: number;
  widthClass?: string;
  rowClass?: string;
  filterAutoFocus?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger's test id. */
  testID: string;
  /** What the list's, filter's and tail's test ids start with. */
  partID: string;
  /** What each agent row's test id starts with (`<optionPrefix>-<ref>`). */
  optionPrefix: string;
  overviewTestID: string;
}) {
  const items = computed(() => normalizeAgentItems(props.items));
  return (
    <PopoverPicker
      items={agentPickerItems(items(), props.optionPrefix)}
      footer={[overviewPickerItem(props.overviewTestID)]}
      value={props.selectedValue}
      onChange={(value) => chooseAgent(items(), value, props.onSelect, props.onOverview)}
      trigger={props.trigger}
      accessibilityLabel={props.accessibilityLabel}
      tooltip={props.tooltip}
      label={t("endpoint_switcher_title")}
      filterPlaceholder={items().length > 8 ? t("endpoint_switcher_filter_placeholder") : undefined}
      filterAutoFocus={props.filterAutoFocus}
      emptyText={t("endpoint_switcher_empty")}
      placement={props.placement}
      align={props.align}
      clearance={props.clearance}
      gap={props.gap}
      widthClass={props.widthClass}
      rowClass={props.rowClass}
      open={props.open}
      onOpenChange={props.onOpenChange}
      testID={props.testID}
      partID={props.partID}
    />
  );
}

/**
 * The agents on the phone's sheet (MobileBottomNav): the bubble's rows, filter and overview row,
 * without the bubble; the sheet carries the title. Rows a finger can take (44pt); the filter (long
 * lists) raises the keyboard only once it is pressed.
 */
export function AgentList(props: {
  items: EndpointItem[];
  selectedValue: string;
  onSelect: (item: AgentOption) => void;
  onOverview: () => void;
  /** While the sheet is up (it takes the keys). */
  open: boolean;
  /** The tallest the list may be. */
  maxHeight: number;
  /** What the list's and filter's test ids start with. */
  partID: string;
  /** What each agent row's test id starts with (`<optionPrefix>-<ref>`). */
  optionPrefix: string;
  overviewTestID: string;
}) {
  const items = computed(() => normalizeAgentItems(props.items));
  return (
    <PickerList
      items={agentPickerItems(items(), props.optionPrefix)}
      footer={[overviewPickerItem(props.overviewTestID)]}
      value={props.selectedValue}
      onChoose={(value) => chooseAgent(items(), value, props.onSelect, props.onOverview)}
      open={props.open}
      accessibilityLabel={t("endpoint_switcher_title")}
      filterPlaceholder={items().length > 8 ? t("endpoint_switcher_filter_placeholder") : undefined}
      filterAutoFocus={false}
      emptyText={t("endpoint_switcher_empty")}
      rowClass="min-h-11 justify-center"
      maxHeight={props.maxHeight}
      class="gap-1"
      testID={`${props.partID}-list`}
      part={(name) => `${props.partID}-${name}`}
    />
  );
}

/** How far the bubble opens from its switcher: past the tail (9pt) with a little air. */
export const AGENT_PICKER_GAP = 12;

export interface AgentSwitcherProps {
  items: EndpointItem[];
  selectedItem: EndpointItem | null;
  /** The avatar the trigger shows (the persona's, else the endpoint's). */
  selectedAvatar?: string | ImageAsset;
  /** The name the trigger shows (the persona's, else the endpoint's). */
  selectedName?: string;
  placeholder?: string;
  /** The folded sidebar: the avatar only, its name as a tooltip. */
  compact?: boolean;
  onChange?: (item: AgentOption) => void;
  onOverview?: () => void;
  class?: string;
}

export function AgentSwitcher(props: AgentSwitcherProps) {
  const open = signal(false);
  trackPopup(open);

  const selectedValue = () => normalizeText(props.selectedItem?.value);
  const triggerName = () =>
    normalizeText(props.selectedName) ||
    normalizeText(props.selectedItem?.title) ||
    normalizeText(props.placeholder) ||
    t("endpoint_placeholder");
  const triggerAvatar = () => {
    const own = props.selectedAvatar;
    if (own && (typeof own !== "string" || own.trim())) return own;
    return props.selectedItem?.image || "";
  };

  // The trigger itself is a plain view: the popover opens on a press of the view around it.
  const trigger = (): JSX.Element => (
    <View
      class={`h-14 flex-row items-center gap-2 ${props.compact && !open() ? "justify-center px-0" : "px-[13px]"} ${
        // Open: the hover's translucent tint, a step deeper; an opaque fill would lighten the
        // sidebar and cover its right edge, which is drawn under the switcher.
        open() ? "bg-hover" : "hover:bg-hover-soft"
      }`}
      style={{ transitionProperty: "colors", transitionDuration: 140, transitionTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)" }}
    >
      <AgentAvatar image={triggerAvatar()} size={24} />
      <If when={!props.compact || open()}>
        <FadeText text={triggerName()} class="flex-1 text-xs font-semibold leading-[14.4px] text-foreground" />
        <View
          class="opacity-75"
          style={{
            rotate: open() ? "180deg" : "0deg",
            transitionProperty: "transform",
            transitionDuration: 180,
            transitionTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
          }}
        >
          <Icon name="PhCaretDown" size={14} color="foreground" />
        </View>
      </If>
    </View>
  );

  return (
    <View class={`h-[57px] border-b border-line-soft ${props.class ?? ""}`} testID="agent-switcher">
      <AgentPicker
        items={props.items}
        selectedValue={selectedValue()}
        onSelect={(item) => props.onChange?.(item)}
        onOverview={() => props.onOverview?.()}
        trigger={() => trigger()}
        accessibilityLabel={t("endpoint_switcher_label")}
        // Folded, the name the avatar stands for; unfolded the name is shown.
        tooltip={props.compact ? <Tip text={triggerName()} placement="right" /> : false}
        // Below the switcher (the composer's profile picker opens above its pill), clear of the
        // sidebar's hairline under it.
        placement="bottom"
        align="start"
        clearance={{ bottom: 1 }}
        gap={AGENT_PICKER_GAP}
        widthClass="w-68"
        open={open()}
        onOpenChange={(next) => open.set(next)}
        testID="agent-switcher-trigger"
        partID="agent-switcher"
        optionPrefix="agent-switcher-option"
        overviewTestID="agent-switcher-overview"
      />
    </View>
  );
}
