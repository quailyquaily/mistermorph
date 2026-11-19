// A choice from a list in a popover beyond its trigger: a light panel with the popovers' continuous
// corners (POPOVER_CORNERS, 12pt; its rows' nested in them), an
// optional filter, a spaced mono section label, rounded rows (an icon, a title, a mono subtitle),
// and a tail on its edge facing the trigger, pointing to it. The composer's LLM profile picker is
// one (a value, the chosen row marked); its add menu another (actions: no `value`, `onChange`
// hears the row pressed); the sidebar's agent switcher a third (components/frame/AgentSwitcher.tsx:
// offline agents as disabled rows, the overview as a `footer` row, opening below the sidebar's top).
// The list itself is `PickerList`, which the phone's agent sheet shows without the bubble.
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
// too) over the rows that are not disabled, the footer's included, Enter picks it, Escape closes.
// A picker opens with its chosen row highlighted; a menu of actions with none (nothing in it is
// chosen): the first Down or Up, or the pointer over a row, gives it one.
//
// The bubble is as tall as its list, up to the room on its side (`maxHeight` at most); a longer
// list scrolls its rows between the filter and the footer (PickerList).
//
// The popup is never wider than the window less its margins, and the tail stays off the popup's
// rounded corners (a trigger near the window's edge: the tail leans to the popup's side of it).
// It opens growing out of its tail (fading in, sliding toward the trigger and scaling up from the
// tail's tip) and closes the same way back. Its list runs from side to side, so the scroll view's
// bar is at the popup's edge; the rows keep their inset inside it.
import type { JSX, ViewRef } from "nsh";
import { Canvas, effect, signal, token, untracked, View, windowSize } from "nsh";
import { Popover } from "nsh/base";
import { MENU_POPUP_STYLE, mobilePopups, PopupList, Tip } from "../ui";
import { cornerReach, nestedRadius, POPOVER_CORNERS, RADIUS } from "../corners";

export { PickerList, type PickerItem, type PickerProbe } from "./PickerList";
import { PickerList, type PickerItem, type PickerProbe } from "./PickerList";

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
/** The popup's padding and border between its edge and its content: above and below (`py-2`
 *  and the border), and at the sides (the border only: the list reaches the popup's sides, and its
 *  parts keep their inset inside it, LIST_INSET). */
const POPUP_INSET_Y = 8 + 1;
const POPUP_INSET_X = 1;
/** How far a popup's rows, filter and label stand in from its sides, inside the list: the scroll
 *  view runs edge to edge, so its bar is at the popup's edge and no margin frames it. */
const LIST_INSET = 8;
/** The rows' corners: the popup's, nested by its border and the list's inset (12 - 9: 3pt). */
const ROW_RADIUS = nestedRadius(RADIUS.popover, POPUP_INSET_X + LIST_INSET);
/** How far along the popup's edge its continuous corner curves, which the tail keeps off. */
const CORNER_REACH = cornerReach(RADIUS.popover);
/** How far the tail's canvas reaches back over the popup: its border row and one inside it, so
 *  the fill covers the border under the tail wherever the edge falls on the pixels. */
const TAIL_OVERLAP = 2;
/** How the popup opens and closes: from a little short of its place toward the trigger, a touch
 *  smaller, transparent (MENU_STARTING's fade, with the scale its tail grows it from). */
const PICKER_STARTING_BELOW = "opacity-0 -translate-y-1.5 scale-[0.96]";
const PICKER_STARTING_ABOVE = "opacity-0 translate-y-1.5 scale-[0.96]";
/** The margin the popover keeps from the window's edges. */
const POPUP_MARGIN = 8;

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
  /** The filter takes the focus as the list opens (default true; touch screens: false, so the
   *  keyboard comes up only once the filter is pressed). */
  filterAutoFocus?: boolean;
  /** Rows under the list, after a hairline: never filtered out, always shown (the overview). They
   *  are picked through `onChange` as the list's rows are. */
  footer?: PickerItem[];
  /** More classes for every row (taller rows for a finger). */
  rowClass?: string;
  /** The trigger's tooltip (default: `accessibilityLabel` above it); `false` for none. */
  tooltip?: JSX.Element | false;
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
  /** Whether the list is on the phone's floating paper instead of the bubble (default: on phones,
   *  `mobilePopups()`; a caller on a touch screen of any width passes true). */
  sheet?: boolean;
  /** Controlled open state; without it the picker keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger's test id. */
  testID?: string;
  /** What the parts' test ids start with (`-list`, `-filter`, `-tail`, `-option-<value>`;
   *  default `testID`). */
  partID?: string;
  /** For tests: the bubble's scroll view and what it reports. */
  probe?: PickerProbe;
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
  const popupWidth = signal(0);
  const part = (name: string) => {
    const id = props.partID ?? props.testID;
    return id ? `${id}-${name}` : undefined;
  };

  // Where the tail stands along the popup's edge (in its content box): over the trigger's middle,
  // kept off the rounded corners.
  const tailLeft = () => {
    const left = anchorMiddle() - (popupLeft() ?? 0) - POPUP_INSET_X - TAIL_WIDTH / 2;
    const width = popupWidth();
    if (width <= 0) return left;
    const least = CORNER_REACH - POPUP_INSET_X;
    const most = width - POPUP_INSET_X - CORNER_REACH - TAIL_WIDTH;
    return Math.max(least, Math.min(most, left));
  };

  const anchorView = () => (
    <View
      ref={(node: ViewRef) => {
        anchor = node;
      }}
    >
      {props.trigger({ open: open() })}
    </View>
  );

  // On phones the bubble has no trigger to stand beside with room for its list: the same rows are
  // on the shared floating paper (design/mobile-popups.md), which the trigger opens.
  const sheet = () => props.sheet ?? mobilePopups();
  // Without a value its rows are commands, not choices: a menu to screen readers too.
  const role = () => (props.value === undefined ? "menu" : "listbox");
  const sheetPicker = () => (
    <>
      <View
        role="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ expanded: open() }}
        testID={props.testID}
        onPress={() => setOpen(!untracked(open))}
      >
        {anchorView()}
      </View>
      <PopupList
        open={open()}
        onClose={() => setOpen(false)}
        label={props.label || props.accessibilityLabel}
        items={props.items}
        footer={props.footer}
        value={props.value}
        role={role()}
        onChoose={(value) => props.onChange(value)}
        filterPlaceholder={props.filterPlaceholder}
        emptyText={props.emptyText}
        partID={props.partID ?? props.testID}
        layerID={part("popup")}
        listProbe={props.probe}
      />
    </>
  );

  return (
    <If when={!props.disabled} else={<View class="opacity-45">{anchorView()}</View>}>
     <If when={!sheet()} else={sheetPicker()}>
      <Popover
        open={open()}
        onOpenChange={({ open: next }) => setOpen(next)}
        placement={placement().side}
        align={props.align ?? "end"}
        offset={placement().offset}
        margin={POPUP_MARGIN}
        onPosition={({ placement: side, bounds }) => {
          shownSide.set(side === "bottom" ? "bottom" : "top");
          popupLeft.set(bounds.origin.x);
          popupWidth.set(bounds.size.width);
        }}
        popupClass={`${props.widthClass ?? "w-72"} ${POPOVER_CORNERS} border border-line-faint bg-dialog py-2 transition duration-180`}
        popupStyle={{
          ...MENU_POPUP_STYLE,
          maxHeight: placement().maxHeight,
          maxWidth: windowSize().width - 2 * POPUP_MARGIN,
          // It grows out of its tail: from the tail's tip, on the side facing the trigger.
          transformOrigin: `${popupLeft() === null ? "50%" : `${POPUP_INSET_X + tailLeft() + TAIL_WIDTH / 2}px`} ${placement().side === "top" ? "100%" : "0%"}`,
        }}
        popupStartingClass={placement().side === "top" ? PICKER_STARTING_ABOVE : PICKER_STARTING_BELOW}
        popupEndingClass={placement().side === "top" ? PICKER_STARTING_ABOVE : PICKER_STARTING_BELOW}
        trigger={
          <View
            role="button"
            accessibilityLabel={props.accessibilityLabel}
            tooltip={props.tooltip === false ? undefined : (props.tooltip ?? <Tip text={props.accessibilityLabel} />)}
            testID={props.testID}
          >
            {anchorView()}
          </View>
        }
      >
        <PickerList
          items={props.items}
          value={props.value}
          onChoose={(value) => {
            props.onChange(value);
            setOpen(false);
          }}
          open={open()}
          accessibilityLabel={props.accessibilityLabel}
          label={props.label}
          filterPlaceholder={props.filterPlaceholder}
          filterAutoFocus={props.filterAutoFocus}
          emptyText={props.emptyText}
          footer={props.footer}
          rowClass={props.rowClass}
          // The popup's cap less its own padding and border.
          maxHeight={placement().maxHeight - 2 * POPUP_INSET_Y}
          role={role()}
          probe={props.probe}
          testID={part("list")}
          part={part}
          inset={LIST_INSET}
          rowRadius={ROW_RADIUS}
          overlay={
            <If when={popupLeft() !== null}>
              <PickerTail
                up={shownSide() === "bottom"}
                style={{
                  left: tailLeft(),
                  ...(shownSide() === "top" ? { bottom: -(POPUP_INSET_Y + TAIL_HEIGHT) } : { top: -(POPUP_INSET_Y + TAIL_HEIGHT) }),
                }}
                testID={part("tail")}
              />
            </If>
          }
        />
      </Popover>
     </If>
    </If>
  );
}
