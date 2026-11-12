// A choice from a list in a popover beyond its trigger: a light panel with large corners, an
// optional filter, a spaced mono section label, rounded rows (an icon, a title, a mono subtitle),
// and a tail on its edge facing the trigger, pointing to it. The composer's LLM profile picker is
// one (a value, the chosen row marked); its add menu another (actions: no `value`, `onChange`
// hears the row pressed).
//
// Why not nsh's Select: on the desktops it opens as the system's own drop-down does, the chosen row
// over the trigger on macOS and below it elsewhere, whatever `placement` says. This opens where it
// is told, as a menu does.
//
// The tail is drawn on the popup itself, over its shadow and in its own colour (drawn beside the
// trigger, under the popup, the popup's shadow greyed it): a curve out of the popup's edge on
// either side into a rounded tip, its outline the popup's border, so the edge flows into it. It
// stands over the trigger's middle, from where the popup and the trigger are.
//
// The side: `placement` when its room holds the list, or has more room than the other side (the
// trigger near the window's top opens it below). It is chosen here from where the trigger is in
// the window, and the list is held to that side's room, so the popover never flips on its own.
// `clearance` is what the popup clears beyond the trigger on each side (the composer's frame around
// its picker): the offset is that plus `gap`.
//
// Keys: the filter takes the focus as it opens; Up and Down move the highlight (from the filter
// too), Enter picks it, Escape closes.
import type { JSX, ViewRef } from "nsh";
import { Canvas, cleanup, effect, keymap, Scroll, signal, Text, token, untracked, View, windowSize } from "nsh";
import { Button as BaseButton, Input, Popover } from "nsh/base";
import { MENU_POPUP_STYLE, MENU_STARTING, Tip } from "../ui";

export interface PickerItem {
  value: string;
  title: string;
  /** A second line in mono (a model, a path). */
  subtitle?: string;
  /** Before the title (a logo, an icon). */
  icon?: JSX.Element;
}

export type PickerSide = "top" | "bottom";

/** Where the list goes: its side, its offset from the trigger, and its height cap. */
export interface PickerPlacement {
  side: PickerSide;
  offset: number;
  maxHeight: number;
}

/**
 * The side, offset and height cap for a trigger `height` tall whose top is at `top` in a window
 * `windowHeight` tall (`top` null while unknown: the preferred side at full height).
 */
export function choosePickerPlacement(options: {
  top: number | null;
  height: number;
  windowHeight: number;
  preferred?: PickerSide;
  clearance?: { top?: number; bottom?: number };
  gap?: number;
  margin?: number;
  max?: number;
  min?: number;
}): PickerPlacement {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const max = options.max ?? 384;
  const min = options.min ?? 160;
  const preferred = options.preferred ?? "top";
  const offsets = {
    top: Math.max(0, options.clearance?.top ?? 0) + gap,
    bottom: Math.max(0, options.clearance?.bottom ?? 0) + gap,
  };
  if (options.top === null) return { side: preferred, offset: offsets[preferred], maxHeight: max };
  const room = {
    top: options.top - offsets.top - margin,
    bottom: options.windowHeight - (options.top + options.height) - offsets.bottom - margin,
  };
  const other: PickerSide = preferred === "top" ? "bottom" : "top";
  const side = room[preferred] >= Math.min(max, room[other]) ? preferred : other;
  return { side, offset: offsets[side], maxHeight: Math.max(min, Math.min(max, room[side])) };
}

/** The tail: its width along the popup's edge and how far it reaches out. */
const TAIL_WIDTH = 24;
const TAIL_HEIGHT = 9;
/** The popup's padding (`p-2`) and border, between its edge and its content. */
const POPUP_INSET = 8 + 1;
/** How far the tail's canvas reaches back over the popup: its border row and one inside it, so
 *  the fill covers the border under the tail wherever the edge falls on the pixels. */
const TAIL_OVERLAP = 2;

/**
 * The tail, drawn pointing down (`up` flips it), on a canvas reaching back over the popup's edge
 * (TAIL_OVERLAP): two curves leave the border's row level on either side and meet in a rounded
 * tip; the fill covers the border under it, the outline carries it on.
 */
function PickerTail(props: { up: boolean; style: Record<string, unknown>; testID?: string }) {
  return (
    <Canvas
      accessibilityElementsHidden
      testID={props.testID}
      style={{ position: "absolute", width: TAIL_WIDTH, height: TAIL_HEIGHT + TAIL_OVERLAP, pointerEvents: "none", ...props.style }}
      draw={(cx, size) => {
        const w = size.width;
        // The border's row is the overlap's last: its middle is where the outline leaves it.
        const edge = TAIL_OVERLAP - 0.5;
        const h = TAIL_HEIGHT + edge;
        if (props.up) {
          cx.translate(0, size.height);
          cx.scale(1, -1);
        }
        const outline = () => {
          cx.moveTo(0, edge);
          cx.bezierCurveTo(w * 0.3, edge, w * 0.38, h, w / 2, h);
          cx.bezierCurveTo(w * 0.62, h, w * 0.7, edge, w, edge);
        };
        cx.fillStyle = String(token("dialog"));
        cx.beginPath();
        cx.moveTo(0, 0);
        outline();
        cx.lineTo(w, 0);
        cx.closePath();
        cx.fill();
        cx.strokeStyle = String(token("line-faint"));
        cx.lineWidth = 1;
        cx.beginPath();
        outline();
        cx.stroke();
      }}
    />
  );
}

export function PopoverPicker(props: {
  items: PickerItem[];
  /** The chosen item's value, marked in the list; none for a menu of actions. */
  value?: string;
  /** The row picked (pressed, or Enter on the highlighted one). */
  onChange: (value: string) => void;
  /** What shows and opens the list; `open` while the list shows (for its pressed look). */
  trigger: (state: { open: boolean }) => JSX.Element;
  /** What screen readers call the trigger (and its tooltip). */
  accessibilityLabel: string;
  /** The section label over the rows, in spaced mono capitals. */
  label?: string;
  /** A filter field over the rows, with this placeholder. */
  filterPlaceholder?: string;
  /** Shown while the filter matches nothing. */
  emptyText?: string;
  disabled?: boolean;
  /** The side the list goes on when it has the room (default `top`). */
  placement?: PickerSide;
  align?: "start" | "center" | "end";
  /** What the popup clears beyond the trigger on each side, in points (the frame around it). */
  clearance?: { top?: number; bottom?: number };
  /** Between what it clears and the popup (default 8). */
  gap?: number;
  /** The popup's width class (default `w-72`). */
  widthClass?: string;
  /** The list's tallest (default 384). */
  maxHeight?: number;
  /** Controlled open state; without it the picker keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testID?: string;
}) {
  const ownOpen = signal(false);
  const open = () => props.open ?? ownOpen();
  const setOpen = (next: boolean) => {
    if (props.open === undefined) ownOpen.set(next);
    props.onOpenChange?.(next);
  };

  // Where the trigger is: measured when the window changes and as the list opens.
  let anchor: ViewRef | undefined;
  const anchorTop = signal<number | null>(null);
  const anchorHeight = signal(0);
  const anchorMiddle = signal(0);
  const measure = () =>
    void anchor?.measure().then((box) => {
      if (!box) return;
      anchorTop.set(box.pagePosition.y);
      anchorHeight.set(box.bounds.size.height);
      anchorMiddle.set(box.pagePosition.x + box.bounds.size.width / 2);
    });
  effect(() => {
    void windowSize().width;
    void windowSize().height;
    void props.clearance?.top;
    void props.clearance?.bottom;
    untracked(measure);
  });
  effect(() => {
    if (open()) untracked(measure);
  });
  const placement = () =>
    choosePickerPlacement({
      top: anchorTop(),
      height: anchorHeight(),
      windowHeight: windowSize().height,
      preferred: props.placement,
      clearance: props.clearance,
      gap: props.gap,
      max: props.maxHeight,
    });
  // The side the popover took and where (it reports them), for the tail.
  const shownSide = signal<PickerSide>("top");
  const popupLeft = signal<number | null>(null);

  // The rows: filtered, one highlighted.
  const query = signal("");
  const active = signal(0);
  const shown = () => {
    const text = query().trim().toLowerCase();
    if (!text) return props.items;
    return props.items.filter((item) => `${item.title} ${item.subtitle ?? ""}`.toLowerCase().includes(text));
  };
  function choose(item: PickerItem | undefined) {
    if (!item) return;
    props.onChange(item.value);
    setOpen(false);
  }
  effect(() => {
    if (!open()) return;
    untracked(() => {
      query.set("");
      active.set(Math.max(0, props.items.findIndex((item) => item.value === props.value)));
    });
    const move = (by: number) => {
      const count = untracked(shown).length;
      if (count) active.set((untracked(active) + by + count) % count);
    };
    cleanup(
      keymap.bind({ up: () => move(-1), down: () => move(1), enter: () => choose(untracked(shown)[untracked(active)]) }, { when: "always" }),
    );
  });

  const anchorView = () => (
    <View
      ref={(node: ViewRef) => {
        anchor = node;
      }}
    >
      {props.trigger({ open: open() })}
    </View>
  );

  return (
    <If when={!props.disabled} else={<View class="opacity-45">{anchorView()}</View>}>
      <Popover
        open={open()}
        onOpenChange={({ open: next }) => setOpen(next)}
        placement={placement().side}
        align={props.align ?? "end"}
        offset={placement().offset}
        margin={8}
        onPosition={({ placement: side, bounds }) => {
          shownSide.set(side === "bottom" ? "bottom" : "top");
          popupLeft.set(bounds.origin.x);
        }}
        popupClass={`${props.widthClass ?? "w-72"} rounded-[16px] border border-line-faint bg-dialog p-2 transition duration-120`}
        popupStyle={{ ...MENU_POPUP_STYLE, maxHeight: placement().maxHeight }}
        popupStartingClass={MENU_STARTING}
        popupEndingClass="opacity-0"
        trigger={
          <View role="button" accessibilityLabel={props.accessibilityLabel} tooltip={<Tip text={props.accessibilityLabel} />} testID={props.testID}>
            {anchorView()}
          </View>
        }
      >
        <View class="relative flex-1 gap-1" testID={props.testID ? `${props.testID}-list` : undefined}>
          <If when={popupLeft() !== null}>
            <PickerTail
              up={shownSide() === "bottom"}
              style={{
                left: anchorMiddle() - (popupLeft() ?? 0) - POPUP_INSET - TAIL_WIDTH / 2,
                ...(shownSide() === "top" ? { bottom: -(POPUP_INSET + TAIL_HEIGHT) } : { top: -(POPUP_INSET + TAIL_HEIGHT) }),
              }}
              testID={props.testID ? `${props.testID}-tail` : undefined}
            />
          </If>
          <If when={props.filterPlaceholder}>
            <Input
              value={query()}
              onChange={({ value }) => {
                query.set(value);
                active.set(0);
              }}
              onSubmit={() => choose(untracked(shown)[untracked(active)])}
              placeholder={props.filterPlaceholder}
              accessibilityLabel={props.filterPlaceholder}
              autoFocus
              testID={props.testID ? `${props.testID}-filter` : undefined}
              class="mx-1 mb-1 rounded-full border border-input px-3 py-1.5 text-sm text-foreground placeholder:text-placeholder"
            />
          </If>
          <If when={props.label}>
            {/* Spaced capitals, upper-cased here: text is measured as written. */}
            <Text class="px-3 pb-1 pt-1.5 font-mono text-[11px] tracking-[0.16em] text-muted-foreground">
              {String(props.label ?? "").toLocaleUpperCase()}
            </Text>
          </If>
          <Scroll class="shrink" style={{ maxHeight: Math.max(80, placement().maxHeight - (props.filterPlaceholder ? 96 : 48)) }}>
            <View class="gap-0.5" role="listbox" accessibilityLabel={props.label ?? props.accessibilityLabel}>
              <Each of={shown()} key={(item) => item.value}>
                {(item, index) => (
                  <View onMouseEnter={() => active.set(index())}>
                    <BaseButton
                      role="option"
                      selected={props.value !== undefined && item().value === props.value}
                      accessibilityLabel={item().title}
                      onPress={() => choose(item())}
                      class={`rounded-[10px] px-3 py-2 transition-colors duration-[120ms] hover:bg-hover selected:bg-selection ${
                        active() === index() ? "bg-hover" : ""
                      }`}
                    >
                      <View class="flex-row items-center gap-2">
                        <If when={item().icon}>{item().icon}</If>
                        <View class="flex-1">
                          <Text class="text-sm text-foreground">{item().title}</Text>
                          <If when={item().subtitle}>
                            <Text class="font-mono text-xs text-muted-foreground">{item().subtitle ?? ""}</Text>
                          </If>
                        </View>
                      </View>
                    </BaseButton>
                  </View>
                )}
              </Each>
              <If when={shown().length === 0}>
                <Text class="px-3 py-2 text-sm text-muted-foreground">{props.emptyText ?? "—"}</Text>
              </If>
            </View>
          </Scroll>
        </View>
      </Popover>
    </If>
  );
}
