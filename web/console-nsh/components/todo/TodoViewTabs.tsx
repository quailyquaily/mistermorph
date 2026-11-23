// The Jobs head's tabs between its three views of the same jobs: the list, the calendar and the
// flow of jobs into each other. They are the shared head tabs (components/shared/HeadTabs.tsx).
// Every view's head holds the same strip at its end, so a view is not a page under another: none
// has a way "back"; and each head's bottom hairline dips under the current view's tab
// (`TodoViewRule`, placed with `todoViewSagCenter`).
import { token } from "nsh";
import { translate } from "../../lib/core/context.js";
import { type HeadTab, HeadTabs, HeadTabsRule, headTabsSagCenter } from "../shared/HeadTabs";
import type { PartLayoutListener } from "../shared/partProbe";
import type { IconName } from "../ui";

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
 * ends `end` points from its right edge with the tabs last in it. null until the head is measured:
 * a straight line.
 */
export function todoViewSagCenter(value: TodoView, flow: boolean, mobile: boolean, width: number, end: number): number | null {
  const tabs = shownTabs(value, flow);
  return headTabsSagCenter(tabs.findIndex((tab) => tab.view === value), mobile, { count: tabs.length, width, end });
}

/** The hairline on a Jobs head's bottom edge, dipping under the current view's tab (HeadTabsRule). */
export function TodoViewRule(props: { center: () => number | null; color?: string }) {
  return <HeadTabsRule center={props.center} color={props.color} testID="todo-view-rule" />;
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
  /** Hears where parts lie on the page (tests): `view-tab-<view>` (its press target), `view-tab-<view>-box` (its circle), `view-tab-<view>-icon`, and the last circle again as `head-action`. */
  onPartLayout?: PartLayoutListener;
}) {
  const tabs = (): HeadTab<TodoView>[] => shownTabs(props.value, !!props.flow).map((tab) => ({ id: tab.view, icon: tab.icon, label: tab.label() }));
  return (
    <HeadTabs
      tabs={tabs()}
      value={props.value}
      onChange={props.onChange}
      mobile={props.mobile}
      testID="todo-view-tabs"
      name="todo-view"
      onPartLayout={props.onPartLayout}
      part={(view) => `view-tab-${view}`}
      lastPart="head-action"
    />
  );
}
