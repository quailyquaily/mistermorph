// The API base and model pickers (the Vue console's SetupPickerDialog and SetupPickerDialogContent):
// a filter, the matching items (grouped by vendor prefix when asked), and a custom row. Up and
// Down move the highlight, Enter picks it, Escape closes.
//
// Vue to nsh: `modelValue` is `open`, `update:modelValue` is `onOpenChange(open)`; `select` is
// `onSelect(item)`, `close` is `onClose()`.
import type { ListRef } from "nsh";
import { batch, computed, effect, keymap, List, signal, Text, untracked, View } from "nsh";
import { buildPickerRows, highlightParts } from "../../lib/core/setup-picker.js";
import { Icon, TextField } from "../ui";
import { DialogShell, InlineNotice, t } from "./DialogShell";
import { LoadingLine } from "../settings-page/parts";

/** A choice: `title` shown, `value` used; `note`, `meta` and `verdict` ("avoid" goes to Others). */
export interface SetupPickerItem {
  id?: string;
  title?: string;
  value?: string;
  note?: string;
  meta?: string;
  verdict?: string;
  [key: string]: unknown;
}

export interface SetupPickerDialogContentProps {
  items: SetupPickerItem[];
  loading?: boolean;
  error?: string;
  filterPlaceholder?: string;
  emptyText?: string;
  /** Default true. */
  showValue?: boolean;
  /** A new value starts the picker afresh (filter cleared, the selection marked). */
  resetKey?: string | number;
  selectedValue?: string;
  groupByPrefix?: boolean;
  allowCustom?: boolean;
  /** "{value}" is the typed text. */
  customLabel?: string;
  onSelect?: (item: SetupPickerItem) => void;
  onClose?: () => void;
}

interface PickerRow {
  item: SetupPickerItem;
  label: string;
  index: number;
}
interface PickerGroup {
  id: string;
  title: string;
  verdict?: string;
  items: PickerRow[];
}
interface PickerRows {
  groups: PickerGroup[];
  custom: { index: number; value: string } | null;
  count: number;
}

/** One line of the list: a group heading, an item, the custom row, or the empty text. */
type Entry =
  | { kind: "group"; key: string; group: PickerGroup }
  | { kind: "item"; key: string; row: PickerRow; group: PickerGroup }
  | { kind: "custom"; key: string; index: number; value: string }
  | { kind: "empty"; key: string };

export function SetupPickerDialogContent(props: SetupPickerDialogContentProps) {
  const query = signal("");
  const active = signal(0);
  let list: ListRef | undefined;
  let visible: [number, number] = [0, -1];

  const rows = computed<PickerRows>(
    () =>
      buildPickerRows(props.items, {
        query: query(),
        groupByPrefix: props.groupByPrefix,
        allowCustom: props.allowCustom,
        labels: { avoid: t("setup_picker_group_avoid"), other: t("setup_picker_group_other") },
      }) as PickerRows,
  );

  const entries = computed<Entry[]>(() => {
    const out: Entry[] = [];
    const current = rows();
    for (const group of current.groups) {
      if (group.title) out.push({ kind: "group", key: `group:${group.id}`, group });
      for (const row of group.items) {
        out.push({ kind: "item", key: `${row.index}:${row.item.id || row.item.value || row.item.title}`, row, group });
      }
    }
    if (current.groups.length === 0 && !current.custom && !props.error) out.push({ kind: "empty", key: "empty" });
    if (current.custom) out.push({ kind: "custom", key: "custom", index: current.custom.index, value: current.custom.value });
    return out;
  });

  const isSelected = (item: SetupPickerItem | undefined) => {
    const selected = String(props.selectedValue || "").trim();
    return selected !== "" && String(item?.value || "") === selected;
  };

  function rowAt(index: number): SetupPickerItem | null {
    const current = untracked(rows);
    for (const group of current.groups) {
      const row = group.items.find((item) => item.index === index);
      if (row) return row.item;
    }
    if (current.custom && current.custom.index === index) {
      return { id: `custom:${current.custom.value}`, title: current.custom.value, value: current.custom.value, note: "" };
    }
    return null;
  }

  function selectedIndex() {
    for (const group of untracked(rows).groups) {
      const row = group.items.find((item) => isSelected(item.item));
      if (row) return row.index;
    }
    return 0;
  }

  /** Scrolls the highlighted row into view when it is outside it. */
  function scrollActiveIntoView(center = false) {
    const index = untracked(active);
    const position = untracked(entries).findIndex(
      (entry) => (entry.kind === "item" && entry.row.index === index) || (entry.kind === "custom" && entry.index === index),
    );
    if (position < 0 || !list) return;
    if (center) {
      list.scrollToIndex({ index: position, viewPosition: 0.5, animated: false });
    } else if (position < visible[0]) {
      list.scrollToIndex({ index: position, viewPosition: 0, animated: false });
    } else if (position > visible[1]) {
      list.scrollToIndex({ index: position, viewPosition: 1, animated: false });
    }
  }

  function selectItem(item: SetupPickerItem | null) {
    if (item) props.onSelect?.(item);
  }

  function move(step: number) {
    const count = untracked(rows).count;
    if (count <= 0) return;
    active.set((untracked(active) + step + count) % count);
    scrollActiveIntoView();
  }

  keymap.bind({ down: () => move(1), up: () => move(-1) }, { when: "always" });

  function resetToSelected() {
    active.set(selectedIndex());
    queueMicrotask(() => scrollActiveIntoView(true));
  }

  // A new filter starts at the first match.
  let lastQuery = untracked(query);
  effect(() => {
    const next = query();
    if (next !== lastQuery) {
      lastQuery = next;
      untracked(() => active.set(0));
    }
  });
  // Each opening starts afresh: the filter cleared, the value in use highlighted.
  let lastReset = untracked(() => props.resetKey);
  effect(() => {
    const key = props.resetKey;
    if (key === lastReset) return;
    lastReset = key;
    untracked(() => {
      batch(() => {
        query.set("");
        lastQuery = "";
      });
      resetToSelected();
    });
  });
  // Items arriving (the model list loaded) highlight the value in use, unless a filter is typed.
  effect(() => {
    void props.items;
    const loading = props.loading;
    untracked(() => {
      if (!loading && !query()) resetToSelected();
    });
  });

  const customText = (value: string) => (props.customLabel ? props.customLabel.replace("{value}", value) : value);

  return (
    <View class="gap-3" testID="setup-picker">
      <TextField
        value={query()}
        clearable={Boolean(query())}
        onChange={(value) => query.set(value)}
        onSubmit={() => selectItem(rowAt(untracked(active)))}
        placeholder={props.filterPlaceholder}
        disabled={props.loading}
        autoFocus
        leadingIcon="PhMagnifyingGlass"
        testID="setup-picker-filter"
      />
      <If when={props.loading}>
        <LoadingLine label={t("setup_llm_test_target_loading")} />
      </If>
      <If when={props.error}>
        <InlineNotice type="error" text={props.error ?? ""} testID="setup-picker-error" />
      </If>
      <If when={!props.loading}>
        <List
          ref={(node: ListRef) => {
            list = node;
          }}
          each={entries()}
          keyExtractor={(entry) => entry.key}
          estimatedItemSize={36}
          role="listbox"
          testID="setup-picker-list"
          class="-mx-1.5"
          style={{ height: Math.min(440, Math.max(44, entries().length * 40)) }}
          contentClass="gap-px px-1.5 pb-0.5"
          onViewableItemsChange={({ viewableItems }) => {
            const indexes = viewableItems.map((token) => token.index);
            visible = indexes.length ? [Math.min(...indexes), Math.max(...indexes)] : [0, -1];
          }}
        >
          {(entry) => <PickerEntry entry={entry()} />}
        </List>
      </If>
    </View>
  );

  function PickerEntry(entryProps: { entry: Entry }) {
    return (
      <>
        <If when={entryProps.entry.kind === "group"}>
          <View class="flex-row items-baseline justify-between gap-2 px-2 pb-1 pt-2.5">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              {(entryProps.entry as Extract<Entry, { kind: "group" }>).group?.title ?? ""}
            </Text>
            <Text class="font-mono text-xs text-muted-foreground">
              {String((entryProps.entry as Extract<Entry, { kind: "group" }>).group?.items.length ?? "")}
            </Text>
          </View>
        </If>
        <If when={entryProps.entry.kind === "item"}>
          <ItemRow entry={entryProps.entry as Extract<Entry, { kind: "item" }>} />
        </If>
        <If when={entryProps.entry.kind === "custom"}>
          <View
            role="option"
            onPress={() => selectItem(rowAt((entryProps.entry as Extract<Entry, { kind: "custom" }>).index))}
            onMouseEnter={() => active.set((entryProps.entry as Extract<Entry, { kind: "custom" }>).index)}
            testID="setup-picker-custom"
            class={`min-h-9 flex-row items-center gap-2.5 rounded-(--radius) px-2 py-1.5 ${
              active() === (entryProps.entry as Extract<Entry, { kind: "custom" }>).index ? "bg-hover" : ""
            }`}
          >
            <Text class="flex-1 text-sm text-foreground">
              {customText((entryProps.entry as Extract<Entry, { kind: "custom" }>).value ?? "")}
            </Text>
            <Text class="text-xs text-muted-foreground">↵</Text>
          </View>
        </If>
        <If when={entryProps.entry.kind === "empty"}>
          <Text class="px-2 py-3 text-sm text-muted-foreground" testID="setup-picker-empty">
            {props.emptyText ?? ""}
          </Text>
        </If>
      </>
    );
  }

  function ItemRow(rowProps: { entry: Extract<Entry, { kind: "item" }> }) {
    const row = () => rowProps.entry.row;
    const selected = () => isSelected(row()?.item);
    const avoid = () => rowProps.entry.group?.verdict === "avoid";
    const parts = () => highlightParts(row()?.label ?? "", query()) as { text: string; match: boolean }[];
    const tint = () => {
      const isActive = active() === row()?.index;
      if (selected()) return isActive ? "bg-selection" : "bg-hover";
      return isActive ? "bg-hover" : "";
    };
    return (
      <View
        role="option"
        accessibilityState={{ selected: selected() }}
        accessibilityLabel={row()?.label}
        onPress={() => selectItem(row()?.item ?? null)}
        onMouseEnter={() => active.set(row()?.index ?? 0)}
        class={`min-h-9 flex-row items-center gap-2.5 rounded-(--radius) px-2 py-1.5 ${tint()}`}
      >
        <View class="flex-1 gap-0.5">
          <Text
            class={`text-sm ${selected() ? "font-semibold text-foreground" : avoid() ? "text-muted-foreground" : "text-foreground"}`}
          >
            <Each of={parts()}>
              {(part) => <Text class={part().match ? "bg-selection" : ""}>{part().text}</Text>}
            </Each>
          </Text>
          <If when={row()?.item.note}>
            <Text class="text-xs text-muted-foreground">{String(row()?.item.note ?? "")}</Text>
          </If>
          <If when={props.showValue !== false && row()?.item.value}>
            <Text class="font-mono text-xs text-muted-foreground line-clamp-1">{String(row()?.item.value ?? "")}</Text>
          </If>
        </View>
        <If when={row()?.item.meta}>
          <Text class="text-xs text-muted-foreground">{String(row()?.item.meta ?? "")}</Text>
        </If>
        <If when={selected()}>
          <Icon name="PhCheck" size={16} color="blue" />
        </If>
      </View>
    );
  }
}

export interface SetupPickerDialogProps extends Omit<SetupPickerDialogContentProps, "resetKey" | "onClose"> {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
}

export function SetupPickerDialog(props: SetupPickerDialogProps) {
  // Each opening starts the picker afresh (filter cleared, selection scrolled into view).
  const openCount = signal(0);
  effect(() => {
    if (props.open) untracked(() => openCount.update((n) => n + 1));
  });
  const close = () => props.onOpenChange?.(false);
  return (
    <DialogShell
      open={props.open}
      title={String(props.title || "").trim()}
      closeDisabled={props.loading}
      onClose={close}
      testID="setup-picker-dialog"
    >
      <If when={props.open}>
        <SetupPickerDialogContent
          items={props.items}
          loading={props.loading}
          error={props.error}
          filterPlaceholder={props.filterPlaceholder}
          emptyText={props.emptyText}
          showValue={props.showValue}
          selectedValue={props.selectedValue}
          groupByPrefix={props.groupByPrefix}
          allowCustom={props.allowCustom}
          customLabel={props.customLabel}
          resetKey={openCount()}
          onSelect={(item) => {
            props.onSelect?.(item);
            close();
          }}
          onClose={close}
        />
      </If>
    </DialogShell>
  );
}
