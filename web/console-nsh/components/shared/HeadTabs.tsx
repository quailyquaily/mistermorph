// A page head's tabs between views of the same thing (the Contacts head's humans and agents, the
// Jobs head's list, calendar and flow): icons only, drawn as the head's round buttons are, with the
// head's bottom hairline dipping under the current tab and gliding to the next one.
//
// - `HeadTabs`: the strip. Each tab is the standard round 38pt button (`circleButtonClass`) with a
//   16pt icon (BAR_ICON_SIZE), the circles flush on a desktop; the current tab a blue icon on a
//   blue tint (`bg-blue/12`), the others quiet with the plain button's hover and press fills. A
//   tab's name is its accessible name and its tooltip, never drawn.
// - `HeadTabsRule`: the hairline with its dip (the soft sag, components/motion/Sag.tsx), for a
//   head that draws its own bottom edge. `headTabsSagCenter` says where the dip goes: along the
//   strip, or along a head whose row ends with the strip.
//
// The strip is nsh/base's `Tabs` and `Tab` (ui.tsx's `Tabs` has no roving focus), so assistive tech
// hears a tab list whose current tab is selected, and the keyboard works as WAI-ARIA's tab list
// pattern says: the list is one Tab stop (at the current tab), Left/Right (and Up/Down, Home/End)
// move to another tab and select it, Space and Return press the focused one; a keyboard focus draws
// a blue ring round the tab's circle. A tab is its 38pt circle on a desktop; on a phone it takes a
// 44pt square of presses (a touch target) with the same circle in its middle, so there the circles
// are 6pt apart, and the strip is pulled 3pt into the head's gutter so the last circle still ends
// where a head's last button does.
import { View, type ViewRef } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { sagHalf, SagRule } from "../motion/Sag";
import { BAR_ICON_SIZE, CIRCLE_BUTTON_ON_FILL, circleButtonClass, Icon, type IconName, Tip } from "../ui";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "./partProbe";

/** A tab: what it shows, and its name (its accessible name and tooltip). */
export interface HeadTab<T extends string = string> {
  id: T;
  icon: IconName;
  label: string;
}

/** A tab's circle, on a desktop and a phone: the head's round buttons' size. */
export const HEAD_TAB_SIZE = 38;
/** A tab's press target on a phone. */
export const HEAD_TAB_TOUCH = 44;

/**
 * A tab's circle: the standard round button (`circleButtonClass`, 38pt, the plain button's hover
 * and press fills) with its icon in the middle, the blue tint while its tab is selected, and a ring
 * while the keyboard is on the tab. The fills follow the tab around it (`group-*`), which on a phone
 * is larger than the circle.
 */
export const HEAD_TAB_CIRCLE_CLASS = `${circleButtonClass()
  .split(/\s+/)
  .map((cls) => (/^(hover|active):/.test(cls) ? `group-${cls}` : cls))
  .join(" ")} border-2 border-transparent group-selected:${CIRCLE_BUTTON_ON_FILL} group-focus-visible:border-blue`;

/** The icons' colours: the current tab blue, the others quiet. */
export const HEAD_TAB_ICON = { selected: "blue", idle: "subtle" } as const;

/** A tab's side: its circle, or the press target on a phone. */
export const headTabSize = (mobile: boolean) => (mobile ? HEAD_TAB_TOUCH : HEAD_TAB_SIZE);

/** How far a phone's strip reaches into the head's gutter, so its last circle ends at the gutter. */
export const headTabsPull = (mobile: boolean) => (mobile ? (HEAD_TAB_TOUCH - HEAD_TAB_SIZE) / 2 : 0);

/**
 * Where the head's hairline dips: the x of tab `index`'s centre along the strip (the tabs are
 * flush, each `headTabSize` wide). With `head` (its width and how far from its right edge its row
 * ends, the strip last in that row) it is the x along that head instead; null while the head is
 * not measured, or for no tab: a straight line.
 */
export function headTabsSagCenter(index: number, mobile: boolean, head?: { count: number; width: number; end: number }): number | null {
  if (index < 0) return null;
  const size = headTabSize(mobile);
  const along = index * size + size / 2;
  if (!head) return along;
  if (head.width <= 0) return null;
  return head.width - head.end + headTabsPull(mobile) - head.count * size + along;
}

/**
 * The hairline on a head's bottom edge: straight in `color` (transparent where the head shows
 * none), dipping in blue under the current tab (`center`, an x along the head) and gliding to the
 * next one. Put it last in the head, which must be positioned and draw over what follows it
 * (`relative z-10`): the dip hangs 6pt below the head's edge.
 */
export function HeadTabsRule(props: { center: () => number | null; color?: string; testID?: string }) {
  return (
    <View class="absolute -bottom-[6px] left-0 right-0 h-[7px]" style={{ pointerEvents: "none" }} testID={props.testID}>
      {/* The line's middle lies 0.5pt down the canvas, which starts 1pt above the head's edge: it fills the head's last point. */}
      <SagRule center={props.center} half={sagHalf(HEAD_TAB_SIZE)} color={props.color ?? "rgba(0, 0, 0, 0)"} line={0.5} class="h-[7px]" />
    </View>
  );
}

export function HeadTabs<T extends string>(props: {
  tabs: readonly HeadTab<T>[];
  value: T;
  onChange: (id: T) => void;
  /** A phone: 44pt press targets. */
  mobile?: boolean;
  /** The strip's test id; a tab's is `<name>-<id>`, and the view around it `<name>-<id>-selected` or `-idle`. */
  testID?: string;
  name: string;
  /** Hears where parts lie on the page (tests): for tab `id`, `part(id)` (its press target), `part(id) + "-box"` (its circle) and `part(id) + "-icon"`; and the last tab's circle again as `lastPart`. */
  onPartLayout?: PartLayoutListener;
  part?: (id: T) => string;
  lastPart?: string;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  return (
    <Tabs class="flex-row items-center" style={{ marginRight: -headTabsPull(!!props.mobile) }} testID={props.testID}>
      <Each of={props.tabs as HeadTab<T>[]} key={(tab) => tab.id}>
        {(tab) => {
          const selected = () => props.value === tab().id;
          let node: ViewRef | undefined;
          let box: PartFrame | undefined;
          let icon: PartFrame | undefined;
          const report = () => {
            const id = tab().id;
            const name = props.part ? props.part(id) : `tab-${id}`;
            parts.report(name, node);
            parts.report(`${name}-box`, node, () => box);
            parts.report(`${name}-icon`, node, () => (box && icon ? { ...icon, x: box.x + icon.x, y: box.y + icon.y } : undefined));
            if (props.lastPart && props.tabs[props.tabs.length - 1]?.id === id) parts.report(props.lastPart, node, () => box);
          };
          return (
            // The tooltip's view (nsh/base's pressables drop a `tooltip` of their own), which also
            // says the tab's state to tests.
            <View
              ref={(value: ViewRef) => {
                node = value;
              }}
              onLayout={() => report()}
              tooltip={<Tip text={tab().label} />}
              testID={`${props.name}-${tab().id}-${selected() ? "selected" : "idle"}`}
            >
              <Tab
                selected={selected()}
                accessibilityLabel={tab().label}
                onPress={() => {
                  if (!selected()) props.onChange(tab().id);
                }}
                testID={`${props.name}-${tab().id}`}
                class={`group items-center justify-center ${props.mobile ? "size-11" : "size-[38px]"}`}
              >
                <View
                  class={HEAD_TAB_CIRCLE_CLASS}
                  onLayout={(event) => {
                    box = boundsFrame(event);
                    report();
                  }}
                >
                  <Icon
                    name={tab().icon}
                    size={BAR_ICON_SIZE}
                    color={selected() ? HEAD_TAB_ICON.selected : HEAD_TAB_ICON.idle}
                    onLayout={(event) => {
                      icon = boundsFrame(event);
                      report();
                    }}
                  />
                </View>
              </Tab>
            </View>
          );
        }}
      </Each>
    </Tabs>
  );
}
