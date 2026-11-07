// The agent switcher at the top of the sidebar (the Vue console's AgentSwitcher): the selected
// agent's avatar and name; pressed, a menu of the agents, online ones first and offline ones
// dimmed and not selectable, and a last row to the overview of every agent. With more than eight
// agents it opens a dialog with a filter instead. Folded, the sidebar shows the avatar only.
import type { ImageAsset, JSX } from "nsh";
import { computed, Image, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton, Menu, MenuItem, MenuSeparator, Tooltip } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import type { EndpointItem } from "../../lib/shell";
import { Icon, Modal, TextField } from "../ui";

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

/** Items whose title or ref holds `query`, ignoring case. */
export function filterAgentItems(items: AgentOption[], query: string) {
  const needle = normalizeText(query).toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) => [item.title, item.value].some((value) => value.toLocaleLowerCase().includes(needle)));
}

/** A round avatar, or an empty disc when there is none. */
export function AgentAvatar(props: { image: string | ImageAsset; size: number; dim?: boolean }) {
  return (
    <If
      when={props.image}
      else={<View class="rounded-full bg-line-soft" style={{ width: props.size, height: props.size }} />}
    >
      <Image
        src={props.image}
        class="rounded-full bg-card"
        accessibilityElementsHidden
        style={{ width: props.size, height: props.size, objectFit: "cover", opacity: props.dim ? 0.7 : 1 }}
      />
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

/** One agent's row: avatar, name, connection mark. */
function AgentRowContent(props: { item: AgentOption }) {
  return (
    <>
      <AgentAvatar image={props.item.image} size={24} dim={!props.item.connected} />
      <Text class={`flex-1 text-sm font-semibold line-clamp-1 ${props.item.connected ? "text-foreground" : "text-muted-foreground"}`}>
        {props.item.title}
      </Text>
      <View class="w-3.5 items-center">
        <ConnectionMark online={props.item.connected} />
      </View>
    </>
  );
}

/** The last row of every switcher: the overview of all agents. */
function OverviewRowContent() {
  return (
    <>
      <View class="w-6 items-center">
        <Icon name="PhNetwork" size={15} color="muted-foreground" />
      </View>
      <Text class="flex-1 text-sm font-semibold text-foreground line-clamp-1">{t("nav_overview")}</Text>
      <Icon name="PhCaretRight" size={14} color="muted-foreground" />
    </>
  );
}

/** The agents grouped as online, then offline, for a dialog or a sheet (plain buttons). */
export function AgentOptionList(props: {
  items: AgentOption[];
  selectedValue: string;
  onSelect: (item: AgentOption) => void;
  rowClass?: string;
  testPrefix?: string;
}) {
  const online = () => props.items.filter((item) => item.connected);
  const offline = () => props.items.filter((item) => !item.connected);
  const row = (item: () => AgentOption) => (
    <BaseButton
      role="option"
      selected={item().value === props.selectedValue}
      disabled={!item().connected}
      onPress={() => props.onSelect(item())}
      accessibilityLabel={item().title}
      testID={`${props.testPrefix ?? "agent-option"}-${item().value}`}
      class={`flex-row items-center gap-2.5 border-y border-transparent hover:bg-hover focus:bg-hover selected:border-blue-lighter selected:bg-selection disabled:opacity-70 ${
        props.rowClass ?? "min-h-9 px-3.5 py-1"
      }`}
    >
      <AgentRowContent item={item()} />
    </BaseButton>
  );
  return (
    <View role="list" accessibilityLabel={t("endpoint_switcher_title")}>
      <If when={online().length > 0}>
        <View accessibilityLabel={t("endpoint_switcher_online")}>
          <Each of={online()} key={(item) => item.value}>
            {(item) => row(item)}
          </Each>
        </View>
      </If>
      <If when={offline().length > 0}>
        <View
          accessibilityLabel={t("endpoint_switcher_offline")}
          class={online().length > 0 ? "mt-1 border-t border-line-faint pt-1" : ""}
        >
          <Each of={offline()} key={(item) => item.value}>
            {(item) => row(item)}
          </Each>
        </View>
      </If>
      <If when={props.items.length === 0}>
        <Text class="px-3.5 py-2.5 text-xs text-muted-foreground">{t("endpoint_switcher_empty")}</Text>
      </If>
    </View>
  );
}

/** The overview row of a dialog or a sheet. */
export function OverviewRow(props: { onPress: () => void; class?: string; testID?: string }) {
  return (
    <BaseButton
      onPress={props.onPress}
      accessibilityLabel={t("nav_overview")}
      testID={props.testID}
      class={`flex-row items-center gap-2.5 border-t border-line-faint hover:bg-hover focus:bg-hover ${props.class ?? "min-h-9 px-3.5"}`}
    >
      <OverviewRowContent />
    </BaseButton>
  );
}

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
  const menuOpen = signal(false);
  const dialogOpen = signal(false);
  const filter = signal("");

  const items = computed(() => normalizeAgentItems(props.items));
  const online = () => items().filter((item) => item.connected);
  const offline = () => items().filter((item) => !item.connected);
  const longMode = () => items().length > 8;
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
  const open = () => menuOpen() || dialogOpen();
  const filtered = () => filterAgentItems(items(), filter());

  const select = (item: AgentOption) => {
    if (!item?.connected) return;
    menuOpen.set(false);
    dialogOpen.set(false);
    props.onChange?.(item);
  };
  const openOverview = () => {
    menuOpen.set(false);
    dialogOpen.set(false);
    props.onOverview?.();
  };
  const openDialog = () => {
    menuOpen.set(false);
    filter.set("");
    dialogOpen.set(true);
  };

  const trigger = (): JSX.Element => (
    <View
      class={`h-full flex-row items-center gap-2 ${props.compact && !open() ? "justify-center px-0" : "px-3"} ${
        open() ? "bg-card" : "hover:bg-hover"
      }`}
    >
      <AgentAvatar image={triggerAvatar()} size={24} />
      <If when={!props.compact || open()}>
        <Text class="flex-1 text-sm font-semibold text-foreground line-clamp-1">{triggerName()}</Text>
        <View style={{ transform: [{ rotate: open() ? "180deg" : "0deg" }] }}>
          <Icon name="PhCaretDown" size={14} color="subtle" />
        </View>
      </If>
    </View>
  );

  const triggerTooltip = () =>
    props.compact ? (
      <Tooltip class="bg-foreground px-2 py-1">
        <Text class="text-xs text-background">{triggerName()}</Text>
      </Tooltip>
    ) : undefined;

  return (
    <View class={`h-12 border-b border-line-soft ${props.class ?? ""}`} testID="agent-switcher">
      <If
        when={longMode()}
        else={
          <Menu
            open={menuOpen()}
            onOpenChange={({ open: next }) => menuOpen.set(next)}
            placement="bottom"
            align="start"
            offset={0}
            popupClass="w-68 max-h-96 border border-line-soft bg-card shadow-lg"
            trigger={
              <View
                class="h-full"
                role="button"
                accessibilityLabel={t("endpoint_switcher_label")}
                accessibilityState={{ expanded: menuOpen() }}
                testID="agent-switcher-trigger"
                tooltip={triggerTooltip()}
              >
                {trigger()}
              </View>
            }
          >
            <Scroll class="shrink" contentClass="py-1">
              <If when={online().length > 0}>
                <Each of={online()} key={(item) => item.value}>
                  {(item) => (
                    <MenuItem
                      checked={item().value === selectedValue() ? true : null}
                      onSelect={() => select(item())}
                      accessibilityLabel={item().title}
                      class="min-h-9 flex-row items-center gap-2.5 border-y border-transparent px-3.5 py-1 hover:bg-hover focus:bg-hover checked:border-blue-lighter checked:bg-selection"
                    >
                      <AgentRowContent item={item()} />
                    </MenuItem>
                  )}
                </Each>
              </If>
              <If when={offline().length > 0}>
                <If when={online().length > 0}>
                  <MenuSeparator class="my-1 h-px bg-line-faint" />
                </If>
                <Each of={offline()} key={(item) => item.value}>
                  {(item) => (
                    <MenuItem
                      disabled
                      accessibilityLabel={item().title}
                      class="min-h-9 flex-row items-center gap-2.5 px-3.5 py-1 opacity-70"
                    >
                      <AgentRowContent item={item()} />
                    </MenuItem>
                  )}
                </Each>
              </If>
              <If when={items().length === 0}>
                <Text class="px-3.5 py-2.5 text-xs text-muted-foreground">{t("endpoint_switcher_empty")}</Text>
              </If>
            </Scroll>
            <MenuItem
              onSelect={openOverview}
              accessibilityLabel={t("nav_overview")}
              class="min-h-9 flex-row items-center gap-2.5 border-t border-line-faint px-3.5 hover:bg-hover focus:bg-hover"
            >
              <OverviewRowContent />
            </MenuItem>
          </Menu>
        }
      >
        <BaseButton
          onPress={openDialog}
          accessibilityLabel={t("endpoint_switcher_label")}
          testID="agent-switcher-trigger"
          tooltip={triggerTooltip()}
          class="h-full"
        >
          {trigger()}
        </BaseButton>
      </If>
      <Modal
        open={dialogOpen()}
        onClose={() => dialogOpen.set(false)}
        title={t("endpoint_switcher_title")}
        size="sm"
        closeLabel={t("action_close")}
        testID="agent-switcher-dialog"
      >
        <TextField
          value={filter()}
          onChange={(value) => filter.set(String(value || ""))}
          placeholder={t("endpoint_switcher_filter_placeholder")}
          testID="agent-switcher-filter"
        />
        <View class="rounded-(--radius) border border-line-soft bg-card">
          <View class="p-1">
            <AgentOptionList items={filtered()} selectedValue={selectedValue()} onSelect={select} />
          </View>
          <OverviewRow onPress={openOverview} testID="agent-switcher-overview" />
        </View>
      </Modal>
    </View>
  );
}
