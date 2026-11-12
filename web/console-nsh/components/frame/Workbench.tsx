// The workbench: a sheet docked along the foot of the whole window on wide windows (as a
// dashboard's workbench), under the sidebar and whatever page is open. It is the frame's, not a
// page's: a page puts what it shows there (`useWorkbench`), such as a reply's plan, progress,
// reasoning or a worker's output from the chat, and takes it out when it closes or the page goes.
//
// It does not cover the page: the sidebar and the page shorten above it, so a conversation and its
// composer stay in use while the output is read. It opens at half of the window's room and keeps
// the height the reader drags its top edge to, as a share of that room (remembered across visits),
// within a minimum at either end: its head and a few lines, and room for a composer above. The edge
// is a separator that takes the focus: the up and down arrows move it too.
//
// It slides in from the foot of the window and back out, in one native layout motion with the page
// above: its slot (always there, 0 tall while it is shut) grows to the sheet's height or shrinks
// back, and the sheet, as tall as it is open and held at the slot's top, rises and sinks with the
// slot's top edge while the page shortens or grows. What it showed stays drawn until it has gone.
//
// Its top is a grab strip with a pill in the middle, so it reads as a sheet whose height changes
// (the pill brightens while it is hovered, focused or dragged). On phones it is the same sheet, and
// it keeps the system's bottom inset clear.
import type { JSX } from "nsh";
import { cleanup, effect, keymap, LayoutAnimation, PanResponder, signal, untracked, View } from "nsh";
import { localStore } from "../../lib/platform";
import { systemInsets } from "../../lib/shell";
import { translate } from "../../lib/core/context.js";
import { Entrance } from "../motion";
import { MOTION_SLOW, motionMs } from "../motion/tokens";
import { Tip } from "../ui";

const t = (key: string) => String(translate(key, null as never));

/** What a page puts in the workbench: an id (a new id plays the content's entrance) and how to draw it. */
export interface WorkbenchContent {
  key: string;
  render: () => JSX.Element;
}

const content = signal<WorkbenchContent | null>(null);

/** Whether the workbench shows something. */
export const workbenchOpen = () => content() !== null;

/** How long it takes to slide in or out. */
const SLIDE_MS = MOTION_SLOW;

/** Opening or shutting it moves the page above in the same motion as it slides. */
function setContent(next: WorkbenchContent | null) {
  const duration = motionMs(SLIDE_MS);
  if ((untracked(content) === null) !== (next === null) && duration > 0) {
    LayoutAnimation.configureNext({ duration, update: { type: "easeInEaseOut" } });
  }
  content.set(next);
}

/**
 * Puts `render` in the workbench while `active()` is true, and takes it out when it turns false or
 * the caller goes. `key()` names what it shows: a new key plays the entrance of the new content.
 */
export function useWorkbench(active: () => boolean, key: () => string, render: () => JSX.Element) {
  let placed: WorkbenchContent | null = null;
  const remove = () => {
    if (placed && untracked(content) === placed) setContent(null);
    placed = null;
  };
  effect(() => {
    const on = active();
    const id = key();
    untracked(() => {
      if (!on) {
        remove();
        return;
      }
      if (placed && placed.key === id && untracked(content) === placed) return;
      placed = { key: id, render };
      setContent(placed);
    });
  });
  cleanup(remove);
}

/* --- its height --- */

const SHARE_STORAGE_KEY = "mistermorph_console_workbench_height_v1";
const DEFAULT_SHARE = 0.5;
/** The least it keeps: its head and a few lines. */
const MIN_SHEET = 140;
/** The least it leaves above: a composer and a little of a conversation. */
const MIN_ABOVE = 200;
/** The grab strip at the sheet's top, with its pill. */
const GRAB_STRIP = 16;
/** How far the grab strip stops short of the sheet's sides (clear of a head's corner button). */
const GRAB_INSET = 56;
/** An arrow key's step, as a share of the room. */
const KEY_STEP = 0.05;

/** A kept share, between a fifth and four fifths of the room (half if unreadable). */
export function clampWorkbenchShare(share: number) {
  return Number.isFinite(share) ? Math.min(0.8, Math.max(0.2, share)) : DEFAULT_SHARE;
}

/** Its height in `room` for `share`, within the minimums at either end. */
export function workbenchHeight(room: number, share: number) {
  const most = Math.max(MIN_SHEET, room - MIN_ABOVE);
  return Math.round(Math.min(most, Math.max(MIN_SHEET, room * share)));
}

const stored = localStore.getItem(SHARE_STORAGE_KEY);
const share = signal(stored ? clampWorkbenchShare(Number(stored)) : DEFAULT_SHARE);

function setShare(next: number, remember: boolean) {
  const value = clampWorkbenchShare(next);
  share.set(value);
  if (remember) localStore.setItem(SHARE_STORAGE_KEY, String(Math.round(value * 1000) / 1000));
}

/**
 * The frame's workbench: the sheet with what a page put in it, under `room`'s height worth of
 * frame (the sidebar and the page above it, and the sheet itself).
 */
export function Workbench(props: { room: number; phone?: boolean }) {
  const height = () => workbenchHeight(props.room, share());
  const open = () => content() !== null;
  // What it shows, kept while it slides out.
  const shown = signal<WorkbenchContent | null>(untracked(content));
  let gone: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const next = content();
    untracked(() => {
      if (gone) clearTimeout(gone);
      gone = undefined;
      if (next) shown.set(next);
      else if (shown()) gone = setTimeout(() => untracked(content) === null && shown.set(null), motionMs(SLIDE_MS) + 40);
    });
  });
  cleanup(() => gone && clearTimeout(gone));
  const items = () => {
    const item = shown();
    return item ? [item] : [];
  };
  const dragging = signal(false);
  let start = 0;
  let last = share();
  const shareOf = (sheet: number) => (props.room > 0 ? workbenchHeight(props.room, sheet / props.room) / props.room : untracked(share));
  const end = () => {
    if (!untracked(dragging)) return;
    dragging.set(false);
    setShare(last, true);
  };
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = untracked(height);
      last = untracked(share);
      dragging.set(true);
    },
    onPanResponderMove: (_event, gesture) => {
      last = shareOf(start - gesture.dy);
      setShare(last, false);
    },
    onPanResponderRelease: end,
    onPanResponderTerminate: end,
  });
  const step = (by: number) => setShare(shareOf(untracked(height) + by * props.room), true);
  let unbind: (() => void) | null = null;
  const stopKeys = () => {
    unbind?.();
    unbind = null;
  };
  cleanup(() => {
    stopKeys();
    end();
  });
  return (
    // The slot: the sheet's height while open, 0 while shut; 8pt in from the window's sides, its top
    // corners rounded, and what it holds clipped to them.
    <View
      class="mx-2 overflow-hidden rounded-tl-[12px] rounded-tr-[12px]"
      style={{ height: open() ? height() : 0 }}
      accessibilityElementsHidden={!open() || undefined}
      importantForAccessibility={open() ? undefined : "no-hide-descendants"}
      testID={open() ? "workbench" : "workbench-shut"}
    >
    {/* The sheet, on the terminal's dark ink (ChatTerminal's TERMINAL_BG): its edge against the
        page needs no line. The grab strip over the top of what it shows; on phones the bottom
        inset under. */}
    <View
      class={`relative bg-[#1b1f3b] ${props.phone && !systemInsets() ? "pb-[env(safe-area-inset-bottom)]" : ""}`}
      style={{ height: height(), paddingBottom: props.phone ? systemInsets()?.bottomNav : undefined }}
    >
      <Each of={items()} key={() => "workbench"}>
        {(item) => (
          <Entrance watch={item().key} class="flex-1">
            <Each of={[item()]} key={(entry) => entry.key}>
              {(entry) => untracked(() => entry().render())}
            </Each>
          </Entrance>
        )}
      </Each>
      {/* The grab strip: drag it (or move it with the arrows) to resize the sheet. Over the top of
          what the sheet shows (its pill above a head's title), short of the corners, where a head
          keeps its buttons. */}
      <View
        {...pan.panHandlers}
        role="adjustable"
        focusable
        accessibilityLabel={t("workbench_resize")}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(share() * 100) }}
        tooltip={<Tip text={t("workbench_resize")} placement="top" />}
        onFocus={() => {
          stopKeys();
          unbind = keymap.bind({ up: () => step(KEY_STEP), down: () => step(-KEY_STEP) });
        }}
        onBlur={stopKeys}
        class="group absolute items-center"
        style={{ top: 0, left: GRAB_INSET, right: GRAB_INSET, height: GRAB_STRIP, cursor: "row-resize" }}
        testID="workbench-edge"
      >
        <View
          class={`mt-1.5 h-1 w-9 rounded-full transition-colors duration-160 group-hover:bg-white/50 group-focus:bg-white/50 ${dragging() ? "bg-white/50" : "bg-white/25"}`}
          testID="workbench-handle"
        />
      </View>
    </View>
    </View>
  );
}
