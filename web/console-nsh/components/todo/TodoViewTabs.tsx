// The Jobs head's tabs between its three views of the same jobs: the list, the calendar and the
// flow of jobs into each other. They are the Contacts head's tabs (pages/contacts/ContactKindTabs):
// icons only, the standard round 38pt button with a 16pt icon, the circles flush on a desktop; the
// current tab a blue icon on a blue tint, the others quiet with the plain button's hover and press
// fills. Every view's head holds the same strip at its end, so a view is not a page under another:
// none has a way "back". Their names are their accessible names and tooltips, never drawn.
//
// nsh/base's `Tabs` and `Tab`, as there: one Tab stop, the arrows move and select, a keyboard focus
// rings the circle. On a phone a tab takes a 44pt square of presses with the same circle in its
// middle, and the strip is pulled 3pt into the head's gutter so its last circle ends at the gutter.
import { token, View, type ViewRef } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import {
  CONTACT_KIND_TAB_CIRCLE_CLASS,
  CONTACT_KIND_TAB_ICON,
  contactKindStripPull,
  contactKindTabSize,
} from "../../pages/contacts/ContactKindTabs";
import { sagHalf, SagRule } from "../motion/Sag";
import { BAR_ICON_SIZE, Icon, type IconName, Tip } from "../ui";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "../shared/partProbe";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export type TodoView = "list" | "calendar" | "flow";

/** The tabs in order: the list first (the page opens on it). */
export const TODO_VIEW_TABS: { view: TodoView; icon: IconName; label: () => string }[] = [
  { view: "list", icon: "PhListBullets", label: () => t("todo_view_list") },
  { view: "calendar", icon: "PhCalendarBlank", label: () => t("todo_view_calendar") },
  { view: "flow", icon: "PhGitFork", label: () => t("todo_view_flow") },
];

/** The tabs a head shows: the flow's only where it has something to draw, or while it is the view. */
const shownTabs = (value: TodoView, flow: boolean) => TODO_VIEW_TABS.filter((tab) => tab.view !== "flow" || flow || value === "flow");

/**
 * Where a head's hairline dips: the x of the current tab's centre in a head `width` wide whose row
 * ends `end` points from its right edge with the tabs last in it (the tabs are flush; a phone's
 * strip reaches 3pt into that room). null until the head is measured: a straight line.
 */
export function todoViewSagCenter(value: TodoView, flow: boolean, mobile: boolean, width: number, end: number): number | null {
  if (width <= 0) return null;
  const tabs = shownTabs(value, flow);
  const at = tabs.findIndex((tab) => tab.view === value);
  if (at < 0) return null;
  const size = contactKindTabSize(mobile);
  return width - end + contactKindStripPull(mobile) - (tabs.length - at - 0.5) * size;
}

/**
 * The hairline on a Jobs head's bottom edge, as under the Contacts and Topics heads: straight in
 * `color` (transparent where the head shows none), dipping in blue under the current view's tab
 * and gliding to the next one. Put it last in the head, which must draw over what follows it
 * (`z-10`): the dip hangs 6pt below the head's edge.
 */
export function TodoViewRule(props: { center: () => number | null; color?: string }) {
  return (
    <View class="absolute -bottom-[6px] left-0 right-0 h-[7px]" style={{ pointerEvents: "none" }} testID="todo-view-rule">
      {/* The line's middle lies 0.5pt down the canvas, which starts 1pt above the head's edge: it fills the head's last point. */}
      <SagRule center={props.center} half={sagHalf(38)} color={props.color ?? "rgba(0, 0, 0, 0)"} line={0.5} class="h-[7px]" />
    </View>
  );
}

/** A hairline colour for `TodoViewRule`, read as the head draws so it follows the theme shown. */
export const todoViewRuleColor = (name: "line-faint" | "line-soft") => String(token(name));

export function TodoViewTabs(props: {
  value: TodoView;
  onChange: (view: TodoView) => void;
  /** The flow has something to show (a runtime that knows which job uses which): its tab is there. */
  flow?: boolean;
  /** A phone: 44pt press targets. */
  mobile?: boolean;
  /** Hears where parts lie on the page (tests): `view-tab-<view>` (its circle), `view-tab-<view>-icon`, and the last circle again as `head-action`. */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  const tabs = () => shownTabs(props.value, !!props.flow);
  return (
    <Tabs class="flex-row items-center" style={{ marginRight: -contactKindStripPull(!!props.mobile) }} testID="todo-view-tabs">
      <Each of={tabs()} key={(tab) => tab.view}>
        {(tab) => {
          const selected = () => props.value === tab().view;
          let node: ViewRef | undefined;
          let box: PartFrame | undefined;
          let icon: PartFrame | undefined;
          const report = () => {
            const view = tab().view;
            parts.report(`view-tab-${view}`, node, () => box);
            parts.report(`view-tab-${view}-icon`, node, () => (box && icon ? { ...icon, x: box.x + icon.x, y: box.y + icon.y } : undefined));
            if (tabs()[tabs().length - 1]?.view === view) parts.report("head-action", node, () => box);
          };
          return (
            // The tooltip's view (nsh/base's pressables drop a `tooltip` of their own), which also
            // says the tab's state to tests.
            <View
              ref={(value: ViewRef) => {
                node = value;
              }}
              onLayout={() => report()}
              tooltip={<Tip text={tab().label()} />}
              testID={`todo-view-${tab().view}-${selected() ? "selected" : "idle"}`}
            >
              <Tab
                selected={selected()}
                accessibilityLabel={tab().label()}
                onPress={() => {
                  if (!selected()) props.onChange(tab().view);
                }}
                testID={`todo-view-${tab().view}`}
                class={`group items-center justify-center ${props.mobile ? "size-11" : "size-[38px]"}`}
              >
                <View
                  class={CONTACT_KIND_TAB_CIRCLE_CLASS}
                  onLayout={(event) => {
                    box = boundsFrame(event);
                    report();
                  }}
                >
                  <Icon
                    name={tab().icon}
                    size={BAR_ICON_SIZE}
                    color={selected() ? CONTACT_KIND_TAB_ICON.selected : CONTACT_KIND_TAB_ICON.idle}
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
