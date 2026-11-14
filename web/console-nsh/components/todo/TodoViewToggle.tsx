// The TODO head's list/calendar toggle, one button in both views so it keeps its place and shape as
// it switches them: the standard round icon button (CircleButton, a 38pt circle) with the head's
// 16pt calendar icon in its middle. In the list it offers the calendar ("Calendar"); in the
// calendar it is on (selected: the soft selection fill and an ink icon, as a selected Button's)
// and offers the list back ("List"). The calendar head used to draw it as a plain square Button
// with the theme's corner radius, so it changed shape as the view changed.
import { View, type ViewRef } from "nsh";
import { translate } from "../../lib/core/context.js";
import { BAR_ICON_SIZE, CircleButton, Icon } from "../ui";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "../shared/partProbe";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** The toggle's look while the calendar shows (CircleButton's `class`): the selected Button's fill. */
export const TODO_VIEW_TOGGLE_ON_CLASS = "selected:bg-selection";

export function TodoViewToggle(props: {
  /** The calendar shows: the toggle is on and switches back to the list. */
  calendar: boolean;
  onPress: () => void;
  /** Hears the toggle's frame on the page (`view-toggle`) and its icon's (`view-toggle-icon`) (tests). */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  let node: ViewRef | undefined;
  let icon: PartFrame | undefined;
  const report = () => {
    parts.report("view-toggle", node);
    parts.report("view-toggle-icon", node, () => icon);
  };
  return (
    <View
      ref={(value: ViewRef) => {
        node = value;
      }}
      onLayout={() => report()}
    >
      <CircleButton
        title={props.calendar ? t("todo_view_list") : t("todo_view_calendar")}
        selected={props.calendar}
        class={TODO_VIEW_TOGGLE_ON_CLASS}
        testID="todo-view-toggle"
        onPress={() => props.onPress()}
      >
        <Icon
          name="PhCalendarBlank"
          size={BAR_ICON_SIZE}
          color={props.calendar ? "ink" : "subtle"}
          onLayout={(event) => {
            icon = boundsFrame(event);
            report();
          }}
        />
      </CircleButton>
    </View>
  );
}
