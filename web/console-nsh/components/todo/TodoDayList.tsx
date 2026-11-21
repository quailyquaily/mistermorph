// The calendar's chosen day, in full: every run of the day, none folded (the month's cells fold the
// repeating ones; this list is where they are all written). On a desktop it stands in the column
// beside the grid, each run on a time rail; on a phone it follows the grid, each run a row on a
// hairline. A run chained from another is under the run that started it, set in. A row opens its job.
//
// It says each thing once: the mark is the outcome (filled: ran; hollow: planned, skipped or
// stopped; the danger colour: failed; the ring: running), so a row has no word for "done" or
// "planned", and only a failure, a skip, a stop or a wait is written beside what started the run.
//
// The calendar (TodoCalendar) works the day out and hands it over as text ready to draw
// (CalendarDayView), through `calendarDay(owner)` when the list is drawn elsewhere on the page.
import { signal, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { StatusMark, type StatusState } from "../ui";
import { ROW_HOVER, ROW_TRANSITION } from "./TodoIndex";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** One line of the day: a run (or several alike, with their count in the title), or the "now" line. */
export interface CalendarDayItem {
  key: string;
  /** The line between what has started and what is planned (today only): its text; else "". */
  now: string;
  jobId: string;
  /** The job is still on the page: the row opens it. */
  open: boolean;
  title: string;
  /** What started it, and how it ended when not as usual. */
  cause: string;
  /** The cause is a failure's: drawn in the danger colour. */
  danger: boolean;
  /** Not run (planned or skipped): the title is quieter. */
  quiet: boolean;
  /** When, as text; "" for a run planned behind another. */
  time: string;
  tone: StatusState;
  /** 0 at the top, one more under each run that started it. */
  depth: number;
  /** The whole row in words (its accessible name). */
  label: string;
}

export interface CalendarDayView {
  /** YYYY-MM-DD. */
  date: string;
  /** "Today", else the date. */
  title: string;
  /** The date, beside "Today"; else "". */
  meta: string;
  items: CalendarDayItem[];
  /** The day's runs are still being read: an empty day says nothing yet. */
  pending: boolean;
}

type DaySignal = ReturnType<typeof signal<CalendarDayView | null>>;
const days = new WeakMap<object, DaySignal>();

/**
 * The chosen day of `owner`'s calendar (the page's state object): the calendar writes it and the
 * day list in the page's side column reads it. Only a signal, so it belongs to no component.
 */
export function calendarDay(owner: object): DaySignal {
  let day = days.get(owner);
  if (!day) {
    day = signal<CalendarDayView | null>(null);
    days.set(owner, day);
  }
  return day;
}

/** A run's mark, as the list's RunMarker draws a job's: the 7pt status square, the ring while it runs. */
function DayMark(props: { tone: StatusState }) {
  return <StatusMark state={props.tone} size={7} corner={2} />;
}

/** How far a chained run is set in under the run that started it. */
const INSET = 18;

export function TodoDayList(props: {
  day: CalendarDayView | null;
  /** Phones: rows on hairlines, the time at the end; else the time rail. */
  mobile?: boolean;
  onOpen?: (jobId: string) => void;
  testID?: string;
}) {
  const items = () => props.day?.items ?? [];
  const open = (item: CalendarDayItem) => {
    if (item.open) props.onOpen?.(item.jobId);
  };
  const titleClass = (item: CalendarDayItem) => (item.quiet || !item.open ? "text-muted-foreground" : "text-foreground");
  const causeClass = (item: CalendarDayItem) => (item.danger ? "text-danger" : "text-muted-foreground");

  /** The line where today turns from what has started to what is planned. */
  const NowLine = (lineProps: { text: string }) => (
    <View class={`flex-row items-center gap-2 ${props.mobile ? "py-2" : "px-1.5 py-[7px]"}`} testID="todo-day-now">
      <Text class="font-mono text-[11px] font-semibold uppercase leading-[15.4px] tracking-[1.32px] text-warn-dark">{lineProps.text}</Text>
      <View class="h-px flex-1 bg-warn" />
    </View>
  );

  const RailRow = (rowProps: { item: () => CalendarDayItem }) => {
    const item = rowProps.item;
    return (
      <BaseButton
        onPress={() => open(item())}
        accessibilityLabel={item().label}
        testID={`todo-day-item-${item().jobId}`}
        class={`flex-row rounded-(--radius-control) ${item().open ? "hover:bg-hover-faint" : ""}`}
        style={ROW_TRANSITION}
        hoverStyle={ROW_HOVER}
      >
        <Text class="w-11 py-2 pl-1.5 font-mono text-xs leading-[16.2px] text-muted-foreground" style={{ numberOfLines: 1 }}>
          {item().time}
        </Text>
        {/* The rail: a hairline through the day, the run's mark on the title's line. */}
        <View class="ml-2.5 w-[9px] items-center" accessibilityElementsHidden>
          <View class="h-3 w-px bg-line" />
          <DayMark tone={item().tone} />
          <View class="w-px flex-1 bg-line" />
        </View>
        <View class="flex-1 gap-0.5 pb-[9px] pr-1.5 pt-[7px]" style={{ paddingLeft: 10 + item().depth * INSET }}>
          <Text class={`text-sm leading-[18px] ${titleClass(item())}`}>{item().title}</Text>
          <If when={item().cause}>
            <Text class={`text-xs leading-[16.2px] ${causeClass(item())}`}>{item().cause}</Text>
          </If>
        </View>
      </BaseButton>
    );
  };

  const PhoneRow = (rowProps: { item: () => CalendarDayItem }) => {
    const item = rowProps.item;
    return (
      <BaseButton
        onPress={() => open(item())}
        accessibilityLabel={item().label}
        testID={`todo-day-item-${item().jobId}`}
        class="min-h-12 flex-row items-center gap-2.5 border-b border-line-soft active:bg-hover-soft"
        style={{ paddingLeft: item().depth * INSET }}
      >
        <View class="w-[9px] items-center" accessibilityElementsHidden>
          <DayMark tone={item().tone} />
        </View>
        <View class="flex-1 py-1.5">
          <Text class={`text-sm leading-[19px] ${titleClass(item())}`}>{item().title}</Text>
          <If when={item().cause}>
            <Text class={`text-xs leading-[16.2px] ${causeClass(item())}`}>{item().cause}</Text>
          </If>
        </View>
        <Text class="font-mono text-xs leading-[16.2px] text-muted-foreground">{item().time}</Text>
      </BaseButton>
    );
  };

  return (
    <View class={props.mobile ? "gap-1.5" : "gap-2.5"} accessibilityLabel={t("todo_calendar_agenda")} testID={props.testID ?? "todo-day-detail"}>
      <View class={`flex-row items-baseline gap-2.5 ${props.mobile ? "" : "px-1.5"}`}>
        <Text
          role="header"
          class={`flex-1 font-normal text-foreground ${props.mobile ? "text-lg leading-[24px] tracking-[-0.4px]" : "text-xl leading-[24px] tracking-[-0.6px]"}`}
          testID="todo-day-title"
        >
          {props.day?.title ?? ""}
        </Text>
        <If when={props.day?.meta}>
          <Text class="font-mono text-xs leading-[16.2px] text-muted-foreground">{props.day?.meta ?? ""}</Text>
        </If>
      </View>
      <View>
        <Each of={items()} key={(item) => item.key}>
          {(item) => (
            <If when={!item().now} else={<NowLine text={item().now} />}>
              {/* The depth is in the test ID: headless runs read no indent. */}
              <View testID={`todo-day-row-d${item().depth}`}>
                <If when={props.mobile} else={<RailRow item={item} />}>
                  <PhoneRow item={item} />
                </If>
              </View>
            </If>
          )}
        </Each>
      </View>
      <If when={items().length === 0 && !props.day?.pending}>
        <Text class={`text-[13px] leading-[19px] text-muted-foreground ${props.mobile ? "" : "px-1.5"}`}>{t("todo_calendar_day_empty")}</Text>
      </If>
    </View>
  );
}
