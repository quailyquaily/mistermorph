// The list a picker shows (PickerList): a filter, a section label, rounded rows (an icon, a title,
// a mono subtitle, something trailing) in a scroll view, and footer rows under them. PopoverPicker
// (components/shared/PopoverPicker.tsx) shows it in its bubble; on phones it is what every popup of
// choices holds, on the shared floating paper (components/ui.tsx `PopupSheet`): the agents' sheet,
// More's neighbours, and the menus, selects and pickers that are dropdowns on the desktops.
// In a file of its own, without components/ui.tsx, so ui.tsx can show it too.
import type { JSX } from "nsh";
import { cleanup, effect, keymap, Scroll, signal, Text, untracked, View, type ScrollRef } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { CONTINUOUS, nestedRadius, RADIUS } from "../corners";

/**
 * The rows' corners on the phone's floating paper (its 18pt dialog corners nested by its hairline
 * and 8pt padding: 9pt), the default; a list in another box passes its own (`rowRadius`).
 */
export const PAPER_ROW_RADIUS = nestedRadius(RADIUS.dialog, 1 + 8);

export interface PickerItem {
  value: string;
  title: string;
  /** A second line in mono (a model, a path). */
  subtitle?: string;
  /** A second line in the text's own face (what a menu's command does). */
  note?: string;
  /** Red: deletes or cannot be undone. */
  danger?: boolean;
  /** Before the title (a logo, an icon). */
  icon?: JSX.Element;
  /** After the title (a status mark, a caret). */
  trailing?: JSX.Element;
  /** Shown dimmed, not pressable; the keys pass over it. */
  disabled?: boolean;
  /** A hairline above the row: the first of another group. */
  separated?: boolean;
  /** More text the filter matches, not shown (an id). */
  keywords?: string;
  /** The row's test id (default `<partID>-option-<value>`). */
  testID?: string;
}

/** For tests: a PickerList's scroll view, and what it reports as it scrolls. */
export interface PickerProbe {
  scroller?: (ref: ScrollRef) => void;
  scroll?: (event: { offset: { x: number; y: number }; size: { width: number; height: number }; contentSize: { width: number; height: number } }) => void;
}

/**
 * The list a picker shows: the filter, the section label, the rows in a scroll view and the footer
 * under them, with the keys (Up, Down, Enter) bound while `open`. PopoverPicker shows it in its
 * bubble; the phone's agent sheet (components/frame/MobileBottomNav.tsx) on a sheet of its own.
 *
 * The list is as tall as its parts, up to `maxHeight`; past that the scroll view alone gives way
 * (the filter, the label and the footer keep their heights), and scrolls its rows. All of it is
 * the layout's: nothing is measured and no part's height is assumed.
 *
 * What scrolls is the rows' own box and nothing else. The view holding the rows clips
 * (`overflow-hidden`, which clips in the layout too) because nsh counts an `Image`'s natural size
 * as overflow whatever its styled size: an icon drawn 16pt from a 256pt SVG reached 240pt past
 * its row, right and down, and the scroll view scrolled over that empty room (PORTING.md).
 *
 * The highlight is the keys' and the pointer's: a list with a `value` opens with its chosen row
 * highlighted; a menu of actions (no `value`), or a list whose value is none of its rows, opens
 * with none, since nothing in it is chosen, and takes one from the first Down or Up, or from the
 * pointer while it is over a row. A row highlighted with nothing chosen read as a chosen one.
 */
export function PickerList(props: {
  items: PickerItem[];
  /** The chosen item's value, marked in the list; none for a menu of actions. */
  value?: string;
  /** The row picked (pressed, or Enter on the highlighted one); never a disabled one. */
  onChoose: (value: string) => void;
  /** While the list shows: it resets its filter and highlight as it opens, and takes the keys. */
  open: boolean;
  /** What screen readers call the rows when there is no label. */
  accessibilityLabel: string;
  /** What the rows are for screen readers: choices of a `listbox` (`option`s; the default), or
   *  the commands of a `menu` (`menuitem`s). */
  role?: "listbox" | "menu";
  /** The section label over the rows, in spaced mono capitals. */
  label?: string;
  /** A filter field over the rows, with this placeholder. */
  filterPlaceholder?: string;
  /** The filter takes the focus as the list opens (default true). */
  filterAutoFocus?: boolean;
  /** Shown while the filter matches nothing. */
  emptyText?: string;
  /** Rows under the list, after a hairline: never filtered out. */
  footer?: PickerItem[];
  /** More classes for every row (taller rows for a finger). */
  rowClass?: string;
  /** The tallest the whole list may be, filter, label and footer included. */
  maxHeight: number;
  /** For tests: the scroll view (to scroll it) and what it reports (its frame and its content's). */
  probe?: PickerProbe;
  /** The list's own classes (default `relative flex-1 gap-1`). */
  class?: string;
  testID?: string;
  /** A part's test id (`filter`, `option-<value>`, `highlighted-<value>` round the highlighted row), or none. */
  part: (name: string) => string | undefined;
  /** Drawn first in the list, over it (the popover's tail). */
  overlay?: JSX.Element;
  /** How far the rows, filter, label and footer stand in from the list's sides (the popover's
   *  list reaches its sides); 0 by default. */
  inset?: number;
  /** The rows' corner radius (continuous), nested in what holds the list (default `PAPER_ROW_RADIUS`). */
  rowRadius?: number;
}) {
  const inset = () => ({ paddingHorizontal: props.inset ?? 0 });
  // The rows: filtered, then the footer's; one highlighted (never a disabled one; -1: none).
  const query = signal("");
  const active = signal(0);
  const footer = () => props.footer ?? [];
  /** A menu of actions: nothing in it is chosen, so nothing is highlighted until asked. */
  const actions = () => props.value === undefined;
  const shown = () => {
    const text = query().trim().toLowerCase();
    if (!text) return props.items;
    return props.items.filter((item) =>
      `${item.title} ${item.subtitle ?? ""} ${item.note ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(text),
    );
  };
  const rows = () => [...shown(), ...footer()];
  /** The next row from `from` by `by` (1 or -1, round the ends) that is not disabled; `from` if none. */
  const step = (from: number, by: number) => {
    const list = untracked(rows);
    // From no row, Up starts at the last one, as Down starts at the first.
    const start = from < 0 && by < 0 ? 0 : from;
    for (let i = 1; i <= list.length; i += 1) {
      const at = (((start + by * i) % list.length) + list.length) % list.length;
      if (!list[at].disabled) return at;
    }
    return from;
  };
  function choose(item: PickerItem | undefined) {
    if (!item || item.disabled) return;
    props.onChoose(item.value);
  }
  effect(() => {
    if (!props.open) return;
    untracked(() => {
      query.set("");
      const chosen = rows().findIndex((item) => item.value === props.value && !item.disabled);
      // No chosen row (a menu of actions, or a value that is none of the rows): none highlighted.
      active.set(chosen);
    });
    const move = (by: number) => active.set(step(untracked(active), by));
    cleanup(
      keymap.bind({ up: () => move(-1), down: () => move(1), enter: () => choose(untracked(rows)[untracked(active)]) }, { when: "always" }),
    );
  });

  /** One row: the list's (`index` among the shown) or the footer's (after them). */
  const row = (item: () => PickerItem, index: () => number) => (
    <View
      onMouseEnter={() => {
        if (!item().disabled) active.set(index());
      }}
      // A menu's highlight leaves with the pointer; a choice's stays for Enter.
      onMouseLeave={() => {
        if (actions() && untracked(active) === index()) active.set(-1);
      }}
      class={item().separated ? "mt-1 border-t border-line-faint pt-1.5" : ""}
      // For tests, which read no fills: the highlighted row's wrapper is named.
      testID={active() === index() ? props.part(`highlighted-${item().value}`) : undefined}
    >
      <BaseButton
        role={props.role === "menu" ? "menuitem" : "option"}
        selected={props.value !== undefined && item().value === props.value}
        disabled={!!item().disabled}
        accessibilityLabel={item().title}
        testID={item().testID ?? props.part(`option-${item().value}`)}
        onPress={() => choose(item())}
        class={`${CONTINUOUS} px-3 py-2 transition-colors duration-[120ms] hover:bg-hover selected:bg-selection disabled:opacity-70 ${
          active() === index() ? "bg-hover" : ""
        } ${props.rowClass ?? ""}`}
        style={{ borderRadius: props.rowRadius ?? PAPER_ROW_RADIUS }}
      >
        <View class="flex-row items-center gap-2">
          <If when={item().icon}>{item().icon}</If>
          <View class="flex-1">
            <Text class={`text-sm ${item().disabled ? "text-muted-foreground" : item().danger ? "text-danger" : "text-foreground"}`}>{item().title}</Text>
            <If when={item().note}>
              <Text class="text-xs text-muted-foreground">{item().note ?? ""}</Text>
            </If>
            <If when={item().subtitle}>
              <Text class="font-mono text-xs text-muted-foreground">{item().subtitle ?? ""}</Text>
            </If>
          </View>
          <If when={item().trailing}>{item().trailing}</If>
        </View>
      </BaseButton>
    </View>
  );

  return (
    <View class={props.class ?? "relative flex-1 gap-1"} style={{ maxHeight: props.maxHeight }} testID={props.testID}>
      {props.overlay}
      <If when={props.filterPlaceholder}>
        <Input
          value={query()}
          onChange={({ value }) => {
            query.set(value);
            active.set(step(-1, 1));
          }}
          onSubmit={() => choose(untracked(rows)[untracked(active)])}
          placeholder={props.filterPlaceholder}
          accessibilityLabel={props.filterPlaceholder}
          autoFocus={props.filterAutoFocus !== false}
          testID={props.part("filter")}
          style={{ marginHorizontal: (props.inset ?? 0) + 4 }}
          class="mb-1 rounded-full border border-input px-3 py-1.5 text-sm text-foreground placeholder:text-placeholder"
        />
      </If>
      <If when={props.label}>
        {/* Spaced capitals, upper-cased here: text is measured as written. */}
        <Text class="px-3 pb-1 pt-1.5 font-mono text-[11px] tracking-[0.16em] text-muted-foreground" style={{ marginHorizontal: props.inset ?? 0 }}>
          {String(props.label ?? "").toLocaleUpperCase()}
        </Text>
      </If>
      <Scroll ref={(node: ScrollRef) => props.probe?.scroller?.(node)} onScroll={props.probe?.scroll} class="shrink">
        <View
          class="gap-0.5 overflow-hidden"
          style={inset()}
          role={props.role ?? "listbox"}
          accessibilityLabel={props.label ?? props.accessibilityLabel}
        >
          <Each of={shown()} key={(item) => item.value}>
            {(item, index) => row(item, index)}
          </Each>
          <If when={shown().length === 0}>
            <Text class="px-3 py-2 text-sm text-muted-foreground">{props.emptyText ?? "—"}</Text>
          </If>
        </View>
      </Scroll>
      <If when={footer().length > 0}>
        <View style={inset()}>
          <View class="gap-0.5 border-t border-line-faint pt-1">
            <Each of={footer()} key={(item) => item.value}>
              {(item, index) => row(item, () => shown().length + index())}
            </Each>
          </View>
        </View>
      </If>
    </View>
  );
}
