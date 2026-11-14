// The TODO calendar (web/console/src/components/TodoCalendar.js, styled as TodoCalendar.css): a
// month of the items' runs, the month in the route's `month` query. Pressing a day selects it and
// reports its items; pressing an item selects the item. On phones the cells show dots and a count,
// and the day's agenda follows. The month changes at once, as in the Vue calendar.
import { computed, effect, signal, Text, untracked, View, windowSize } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { currentLocale, translate } from "../../lib/core/context.js";
import { formatDate } from "../../lib/core/intl-format.js";
import { projectTodoCalendar, visibleCalendarDays } from "../../lib/core/todo-calendar.js";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { gutterX, gutterY } from "../frame/metrics";
import { MOTION_EASE_CSS } from "../motion";
import { BAR_ICON_SIZE, Button, CircleButton, Tip, TipButton, type IconName } from "../ui";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import { TODO_HEAD_HEIGHT, TODO_INDEX_WIDTH, todoHeadPaddingRight } from "./TodoIndex";
import { TodoViewToggle } from "./TodoViewToggle";
import type { CalendarSelection, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function monthDate(value: unknown) {
  const match = String(value || "").match(MONTH_PATTERN);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) {
    return null;
  }
  const date = new Date(year, month - 1, 1);
  return date.getFullYear() === year && date.getMonth() === month - 1 ? date : null;
}

function dateFromKey(value: unknown) {
  const match = String(value || "").match(DATE_PATTERN);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDays(date: Date, count: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function browserTimezone() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim() || "UTC";
  } catch {
    return "UTC";
  }
}

interface CalendarDay {
  key: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

interface CalendarEntry {
  task_id: string;
  date: string;
  first_at: string;
  task: TodoTask;
}

export interface TodoCalendarProps {
  tasks: TodoTask[];
  tasksLoading?: boolean;
  /** Phones: dots in the cells, the agenda below, no add button (the page's floating one adds). */
  mobile?: boolean;
  taskTitle: (task: TodoTask) => string;
  scheduleLabel: (task: TodoTask) => string;
  onAddTask?: () => void;
  onSelectDate?: (selection: CalendarSelection) => void;
  onSelectTask?: (task: TodoTask) => void;
  onShowList?: () => void;
  /** Hears where parts lie on the page (tests): `view-toggle` and `view-toggle-icon` (the list
   * toggle in the head and its icon), `head` (the head's row over the list's width). */
  onPartLayout?: PartLayoutListener;
}

export function TodoCalendar(props: TodoCalendarProps) {
  const parts = createPartProbe(() => props.onPartLayout);
  const timezone = browserTimezone();
  const selectedDate = signal("");
  const expandedDate = signal("");

  const activeMonth = computed(() => {
    const now = new Date();
    return monthDate(currentRoute()?.query?.month) || new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const activeMonthKey = computed(() => monthKey(activeMonth()));
  const days = computed(() => visibleCalendarDays(activeMonth()) as CalendarDay[]);
  const projection = computed(() => {
    const from = dateFromKey(days()[0]?.key) || activeMonth();
    try {
      return projectTodoCalendar(props.tasks, from, addDays(from, 42), timezone) as {
        items: { task_id: string; date: string; first_at: string }[];
      };
    } catch (error) {
      console.warn("todo calendar projection failed", (error as Error)?.message || error);
      return { items: [] };
    }
  });
  const monthTitle = computed(() => formatDate(activeMonth(), currentLocale(), { year: "numeric", month: "long" }));
  const weekdayLabels = () => [
    t("todo_weekday_sun"),
    t("todo_weekday_mon"),
    t("todo_weekday_tue"),
    t("todo_weekday_wed"),
    t("todo_weekday_thu"),
    t("todo_weekday_fri"),
    t("todo_weekday_sat"),
  ];
  const taskByID = computed(() => {
    const result = new Map<string, TodoTask>();
    props.tasks.forEach((task) => {
      const id = String(task?.id || "").trim();
      if (id && !result.has(id)) {
        result.set(id, task);
      }
    });
    return result;
  });
  const entriesByDate = computed(() => {
    const grouped = new Map<string, CalendarEntry[]>();
    projection().items.forEach((item) => {
      const task = taskByID().get(String(item?.task_id || "").trim());
      const date = String(item?.date || "").trim();
      if (!task || !DATE_PATTERN.test(date)) {
        return;
      }
      const entry = { ...item, task };
      if (!grouped.has(date)) {
        grouped.set(date, []);
      }
      grouped.get(date)!.push(entry);
    });
    return grouped;
  });
  const selectedDateEntries = computed(() => entriesByDate().get(selectedDate()) || []);
  const selectedDateTitle = computed(() => {
    const date = dateFromKey(selectedDate());
    return date
      ? formatDate(date, currentLocale(), { year: "numeric", month: "long", day: "numeric" })
      : selectedDate();
  });
  const isEmpty = computed(() => !props.tasksLoading && projection().items.length === 0);
  const weeks = computed(() => {
    const list = days();
    return Array.from({ length: 6 }, (_, index) => ({ key: list[index * 7]?.key ?? String(index), days: list.slice(index * 7, index * 7 + 7) }));
  });

  function entriesFor(day: CalendarDay) {
    return entriesByDate().get(day.key) || [];
  }

  function taskIsRecurring(task: TodoTask) {
    return !String(task?.at || "").trim();
  }

  function entryTime(entry: CalendarEntry) {
    const date = new Date(entry?.first_at);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return formatDate(date, currentLocale(), { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  }

  function entryMeta(entry: CalendarEntry) {
    return taskIsRecurring(entry?.task) ? props.scheduleLabel(entry.task) : entryTime(entry);
  }

  // Calendar cells are narrow: show a 24-hour run time; the schedule description goes in the tooltip.
  function entryCellMeta(entry: CalendarEntry) {
    const date = new Date(entry?.first_at);
    if (Number.isNaN(date.getTime())) {
      return entryMeta(entry);
    }
    return formatDate(date, currentLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
  }

  function entryAccessibleName(entry: CalendarEntry) {
    const status = entry?.task?.enabled === false ? t("todo_calendar_disabled") : t("todo_calendar_enabled");
    const kind = taskIsRecurring(entry?.task) ? t("todo_calendar_recurring") : t("todo_calendar_once");
    return `${entry?.date || ""}, ${entryMeta(entry)}, ${props.taskTitle(entry?.task)}, ${kind}, ${status}`;
  }

  function emitDateSelection(activate: boolean) {
    props.onSelectDate?.({
      date: untracked(selectedDate),
      title: untracked(selectedDateTitle),
      task_ids: untracked(selectedDateEntries).map((entry) => entry.task_id),
      activate,
    });
  }

  function selectDate(day: CalendarDay) {
    selectedDate.set(day.key);
    expandedDate.set("");
    emitDateSelection(true);
  }

  function selectEntry(entry: CalendarEntry) {
    selectedDate.set(entry.date);
    expandedDate.set("");
    emitDateSelection(false);
    props.onSelectTask?.(entry.task);
  }

  function toggleOverflow(day: CalendarDay) {
    selectedDate.set(day.key);
    expandedDate.set(untracked(expandedDate) === day.key ? "" : day.key);
    emitDateSelection(true);
  }

  function goToMonth(next: Date) {
    const route = untracked(currentRoute);
    void navigate(locationOf(route?.path || "/", { ...(route?.query || {}), view: "calendar", month: monthKey(next) }));
  }

  function setMonth(delta: number) {
    const month = untracked(activeMonth);
    expandedDate.set("");
    goToMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  }

  function showToday() {
    const today = new Date();
    selectedDate.set(dateKey(today));
    expandedDate.set("");
    emitDateSelection(true);
    goToMonth(today);
  }

  // A new month selects today when it shows it, else its first day.
  effect(() => {
    const key = activeMonthKey();
    untracked(() => {
      const today = dateKey(new Date());
      selectedDate.set(days().some((day) => day.key === today) ? today : `${key}-01`);
      expandedDate.set("");
      emitDateSelection(true);
    });
  });

  // The selected day's items are reported again when they change.
  let lastEntries: string | null = null;
  effect(() => {
    const ids = selectedDateEntries()
      .map((entry) => entry.task_id)
      .join("\u0000");
    untracked(() => {
      if (lastEntries !== null && lastEntries !== ids) {
        emitDateSelection(false);
      }
      lastEntries = ids;
    });
  });

  // The grid's width tells how wide a day is: a day 132pt wide or less shows its items' titles
  // only (the Vue cells' container query), the run time staying in the item's name.
  const gridWidth = signal(0);
  const narrowCells = () => gridWidth() > 0 && (gridWidth() - 8) / 7 <= 132;
  const windowHeight = () => windowSize().height;

  /** A run in a cell, the popover or the agenda (`.todo-calendar-entry`). */
  const EntryButton = (entryProps: {
    entry: () => CalendarEntry;
    meta: (entry: CalendarEntry) => string;
    /** cell: in a month cell (6pt square, 11pt mono time); list: the popover's and agenda's rows. */
    cell?: boolean;
    outside?: boolean;
    agenda?: boolean;
  }) => {
    const disabled = () => entryProps.entry().task.enabled === false;
    const showMeta = () => !entryProps.cell || !narrowCells();
    return (
      <TipButton
        onPress={() => selectEntry(entryProps.entry())}
        accessibilityLabel={entryAccessibleName(entryProps.entry())}
        tooltip={<Tip text={entryMeta(entryProps.entry())} />}
        class={`flex-row items-center ${
          entryProps.cell ? "gap-1.5 rounded-(--radius) py-[3px] pl-[5px] pr-1.5" : "gap-[5px] px-1 py-[3px]"
        } ${entryProps.agenda ? "min-h-[38px] px-2 py-[7px]" : ""} ${
          entryProps.outside
            ? "hover:bg-blue/5"
            : disabled()
              ? "bg-line-soft/40 hover:bg-blue/13"
              : "bg-blue/7 hover:bg-blue/13"
        }`}
        style={{ transitionProperty: "colors", transitionDuration: 120 }}
      >
        <View
          class={`${entryProps.cell ? "size-1.5 rounded-[1px]" : "size-[7px]"} ${disabled() ? "bg-muted-foreground" : "bg-blue"} ${
            entryProps.outside ? "opacity-50" : ""
          }`}
        />
        <Text
          class={`flex-1 text-xs font-medium leading-[15px] ${
            disabled() || entryProps.outside ? "text-muted-foreground" : "text-foreground"
          }`}
          style={{ numberOfLines: 1 }}
        >
          {props.taskTitle(entryProps.entry().task)}
        </Text>
        <If when={showMeta()}>
          <Text
            class={`font-mono leading-[15px] text-muted-foreground ${entryProps.cell ? "text-[11px]" : "max-w-[38%] text-xs"} ${
              entryProps.outside ? "opacity-50" : ""
            }`}
            style={{ numberOfLines: 1 }}
          >
            {entryProps.meta(entryProps.entry())}
          </Text>
        </If>
      </TipButton>
    );
  };

  /** A day of the month (`.todo-calendar-day`). */
  const DayCell = (dayProps: { day: () => CalendarDay; column: number }) => {
    const day = () => dayProps.day();
    const selected = () => day().key === selectedDate();
    const weekend = () => dayProps.column === 0 || dayProps.column === 6;
    // Out of the month: paper; in it: white, weekends tinted 2.5 %, today 6 % (blue on white).
    const fill = () => (day().inMonth ? "bg-card" : "bg-paper");
    const tint = () => (!day().inMonth ? "" : day().isToday ? "bg-blue/6" : weekend() ? "bg-blue/[0.025]" : "");
    return (
      <View
        role="cell"
        accessibilityLabel={day().key}
        accessibilityState={{ selected: selected() }}
        testID={`todo-calendar-day-${day().key}`}
        onPress={() => selectDate(day())}
        class={`group relative flex-1 ${props.mobile ? "p-[3px]" : "pb-2 pl-[7px] pr-[7px] pt-[7px]"} ${fill()}`}
      >
        <If when={tint()}>
          <View accessibilityElementsHidden class={`absolute inset-0 ${tint()}`} style={{ pointerEvents: "none" }} />
        </If>
        {/* The hover and selection rings, drawn inside the cell (an inset 1pt line). */}
        <View
          accessibilityElementsHidden
          class={`absolute inset-0 border ${selected() ? "border-blue/60" : "border-transparent group-hover:border-line-soft"}`}
          style={{ pointerEvents: "none" }}
        />
        <BaseButton
          onPress={() => selectDate(day())}
          selected={selected()}
          accessibilityLabel={day().key}
          class={`items-center justify-center self-start rounded-(--radius) ${props.mobile ? "size-[23px]" : "size-[25px]"} ${
            day().isToday ? "bg-blue" : ""
          }`}
        >
          <Text
            class={`font-semibold ${props.mobile ? "text-[11px]" : "text-xs"} ${
              day().isToday ? "text-paper" : day().inMonth ? "text-subtle" : "text-muted-foreground opacity-70"
            }`}
          >
            {String(day().day)}
          </Text>
        </BaseButton>
        <If
          when={!props.mobile}
          else={
            <If when={entriesFor(day()).length > 0}>
              <View class="mt-px flex-row items-center justify-center gap-0.5" accessibilityElementsHidden>
                <Each of={entriesFor(day()).slice(0, 3)} key={(entry) => `${entry.task_id}:${entry.date}`}>
                  {(entry) => <View class={`size-1 ${entry().task.enabled === false ? "bg-muted-foreground" : "bg-blue"}`} />}
                </Each>
                <Text class="ml-0.5 text-[11px] leading-[11px] text-muted-foreground">{String(entriesFor(day()).length)}</Text>
              </View>
            </If>
          }
        >
          <View class="mt-[3px] gap-[3px]">
            <Each of={entriesFor(day()).slice(0, 3)} key={(entry) => `${entry.task_id}:${entry.date}`}>
              {(entry) => <EntryButton entry={entry} meta={entryCellMeta} cell outside={!day().inMonth} />}
            </Each>
            <If when={entriesFor(day()).length > 3}>
              <Popover
                open={expandedDate() === day().key}
                onOpenChange={({ open }) => {
                  if (!open && untracked(expandedDate) === untracked(day).key) expandedDate.set("");
                }}
                placement="bottom"
                align={dayProps.column >= 5 ? "end" : "start"}
                offset={2}
                // `.todo-calendar-overflow`: 320 wide, a line frame on paper with the large shadow.
                popupClass="max-h-70 w-80 gap-1 border border-line bg-paper p-[9px] transition duration-120"
                popupStyle={{ boxShadow: "0 12px 34px rgba(20, 29, 48, 0.18)", transitionTimingFunction: MOTION_EASE_CSS }}
                popupStartingClass="opacity-0 -translate-y-1"
                popupEndingClass="opacity-0"
                trigger={
                  <BaseButton
                    onPress={() => toggleOverflow(day())}
                    accessibilityLabel={t("todo_calendar_more", { count: entriesFor(day()).length - 3 })}
                    class="self-start px-1 py-0.5"
                  >
                    <Text class="text-xs text-blue">{t("todo_calendar_more", { count: entriesFor(day()).length - 3 })}</Text>
                  </BaseButton>
                }
              >
                <Text class="px-1 pb-1.5 pt-0.5 font-mono text-xs font-semibold text-muted-foreground">{day().key}</Text>
                <Each of={entriesFor(day())} key={(entry) => `${entry.task_id}:${entry.date}`}>
                  {(entry) => <EntryButton entry={entry} meta={entryCellMeta} />}
                </Each>
              </Popover>
            </If>
          </View>
        </If>
      </View>
    );
  };

  /** A plain icon button of the toolbar, centred in its row (Button sits at the top of its box). */
  const ToolButton = (buttonProps: { icon: IconName; title: string; testID?: string; onPress: () => void }) => (
    <View>
      <Button
        variant="plain"
        iconOnly
        icon={buttonProps.icon}
        title={buttonProps.title}
        testID={buttonProps.testID}
        onPress={buttonProps.onPress}
      />
    </View>
  );

  return (
    <View
      class="flex-1"
      style={{ paddingHorizontal: props.mobile ? gutterX() : 8, paddingBottom: props.mobile ? gutterY() : 8 }}
      accessibilityLabel={t("todo_view_calendar")}
      testID="todo-calendar"
    >
      {/* The toolbar: the index's head (title, list toggle, add) over the list's width, then the
          month and the way through months (Today, then ‹ ›). One 57pt row on desktops; two rows on
          phones, without the add button (the floating one adds). */}
      <View
        class={props.mobile ? "" : "flex-row items-center gap-4"}
        style={{ height: props.mobile ? undefined : TODO_HEAD_HEIGHT, marginHorizontal: props.mobile ? -gutterX() : -8 }}
      >
        {/* The list's head as TodoIndex draws it (the same padding, the same round buttons, its
            hairline's 1pt, here never drawn), so the toggle stays where it was, the same circle,
            as the view switches. */}
        <View
          class="flex-row items-center border-b border-transparent"
          style={{
            width: props.mobile ? undefined : TODO_INDEX_WIDTH,
            minHeight: TODO_HEAD_HEIGHT,
            paddingLeft: gutterX(),
            paddingRight: todoHeadPaddingRight(!!props.mobile),
          }}
          {...parts.probe(() => "head")}
        >
          <Text class="flex-1 text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground" role="header" style={{ numberOfLines: 1 }}>
            {t("todo_title")}
          </Text>
          <TodoViewToggle calendar onPress={() => props.onShowList?.()} onPartLayout={props.onPartLayout} />
          <If when={!props.mobile}>
            <CircleButton icon="PhPlus" iconSize={BAR_ICON_SIZE} title={t("todo_action_add")} testID="todo-calendar-add" onPress={() => props.onAddTask?.()} />
          </If>
        </View>
        <View
          class={`flex-row items-center justify-between gap-3 ${props.mobile ? "min-h-11 pb-2" : "flex-1"}`}
          style={{ paddingLeft: props.mobile ? gutterX() : 0, paddingRight: gutterX() }}
        >
          <Text
            class={`flex-1 font-semibold text-foreground ${windowSize().width <= 520 ? "text-base" : "text-lg"}`}
            style={{ numberOfLines: 1 }}
            testID="todo-calendar-month"
          >
            {monthTitle()}
          </Text>
          <View class="flex-row items-center gap-0.5">
            <View class="mr-1.5">
              <ToolButton icon="PhCalendarDot" title={t("todo_calendar_today")} onPress={showToday} />
            </View>
            <ToolButton icon="PhCaretLeft" title={t("todo_calendar_previous")} onPress={() => setMonth(-1)} />
            <ToolButton icon="PhCaretRight" title={t("todo_calendar_next")} onPress={() => setMonth(1)} />
          </View>
        </View>
      </View>

      {/* The weekdays' row: framed, tinted blue 4 % on paper, weekends a shade quieter. */}
      <View class="flex-row border-x border-t border-line bg-blue/4" role="row">
        <Each of={weekdayLabels()}>
          {(label, index) => (
            <View class={`flex-1 ${index() > 0 ? "border-l border-line-soft" : ""} ${props.mobile ? "px-0.5 py-1.5" : "px-2.5 py-[7px]"}`}>
              <Text
                class={`text-xs font-semibold uppercase tracking-[0.3px] text-muted-foreground ${props.mobile ? "text-center" : ""} ${
                  index() === 0 || index() === 6 ? "opacity-70" : ""
                }`}
                style={{ numberOfLines: 1 }}
              >
                {label()}
              </Text>
            </View>
          )}
        </Each>
      </View>

      <If
        when={!props.tasksLoading}
        else={
          <View class="min-h-105 gap-2 border border-line p-3" accessibilityLabel={t("todo_view_calendar")}>
            <Each of={[0, 1, 2]}>{() => <View class="h-[118px] animate-pulse rounded-(--radius) bg-muted" />}</Each>
          </View>
        }
      >
        <View
          class={`relative gap-px border-x border-b border-line bg-line ${props.mobile ? "" : "flex-1"}`}
          style={props.mobile ? undefined : { minHeight: Math.min(720, windowHeight() - 118) }}
          onLayout={(event) => gridWidth.set(event.bounds.size.width)}
          role="grid"
        >
          <Each of={weeks()} key={(week) => week.key}>
            {(week) => (
              <View class={`flex-row gap-px ${props.mobile ? "h-[58px]" : "min-h-28 flex-1"}`}>
                <Each of={week().days} key={(day) => day.key}>
                  {(day, column) => <DayCell day={day} column={column()} />}
                </Each>
              </View>
            )}
          </Each>
          {/* No runs this month: the note over the grid, which shows through blurred. */}
          <If when={isEmpty()}>
            <View
              class="absolute inset-0 items-center justify-center gap-[5px] bg-paper-soft p-6 backdrop-blur-[3px]"
              style={{ pointerEvents: "none" }}
            >
              <Text class="text-center text-base font-semibold text-foreground">{t("todo_calendar_empty")}</Text>
              <Text class="text-center text-base text-muted-foreground">{t("todo_calendar_empty_hint")}</Text>
            </View>
          </If>
        </View>
      </If>

      <If when={props.mobile}>
        <View class="gap-2 pt-3" accessibilityLabel={t("todo_calendar_agenda")}>
          <View class="border-b border-line pb-[7px]">
            <Text class="text-sm font-semibold text-foreground">{selectedDateTitle()}</Text>
          </View>
          <If
            when={selectedDateEntries().length > 0}
            else={<Text class="text-xs text-muted-foreground">{t("todo_calendar_day_empty")}</Text>}
          >
            <View class="gap-1">
              <Each of={selectedDateEntries()} key={(entry) => `agenda:${entry.task_id}:${entry.date}`}>
                {(entry) => <EntryButton entry={entry} meta={entryMeta} agenda />}
              </Each>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
