// The TODO calendar (web/console/src/components/TodoCalendar.js): a month of the items' runs, the
// month in the route's `month` query. Pressing a day selects it and reports its items; pressing an
// item selects the item. On phones the cells show dots and a count, and the day's agenda follows.
import { computed, effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { currentLocale, translate } from "../../lib/core/context.js";
import { formatDate } from "../../lib/core/intl-format.js";
import { projectTodoCalendar, visibleCalendarDays } from "../../lib/core/todo-calendar.js";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { Button, Skeleton } from "../ui";
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
}

export function TodoCalendar(props: TodoCalendarProps) {
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

  const EntryButton = (entryProps: { entry: () => CalendarEntry; meta: (entry: CalendarEntry) => string; agenda?: boolean }) => (
    <BaseButton
      onPress={() => selectEntry(entryProps.entry())}
      accessibilityLabel={entryAccessibleName(entryProps.entry())}
      class={`flex-row items-center gap-1.5 rounded-(--radius) px-1 hover:bg-hover active:bg-selection ${
        entryProps.agenda ? "min-h-9 border border-line-faint bg-card px-2 py-1.5" : "py-0.5"
      }`}
    >
      <View
        class={`size-1.5 ${entryProps.entry().task.enabled === false ? "border border-status-off" : "bg-status-on"}`}
      />
      <Text
        class={`flex-1 text-xs line-clamp-1 ${
          entryProps.entry().task.enabled === false ? "text-muted-foreground line-through" : "text-foreground"
        }`}
      >
        {props.taskTitle(entryProps.entry().task)}
      </Text>
      <Text class="font-mono text-xs text-muted-foreground line-clamp-1">{entryProps.meta(entryProps.entry())}</Text>
    </BaseButton>
  );

  return (
    <View class="flex-1 gap-2" accessibilityLabel={t("todo_view_calendar")} testID="todo-calendar">
      <View class={`gap-1 ${props.mobile ? "" : "flex-row items-center justify-between"}`}>
        <View class="min-h-11 flex-row items-center gap-1">
          <Text class="flex-1 text-base font-semibold text-foreground" role="header">
            {t("todo_title")}
          </Text>
          <Button
            variant="plain"
            iconOnly
            icon="PhCalendarBlank"
            title={t("todo_view_list")}
            selected
            testID="todo-view-toggle"
            onPress={() => props.onShowList?.()}
          />
          <If when={!props.mobile}>
            <Button
              variant="plain"
              iconOnly
              icon="PhPlus"
              title={t("todo_action_add")}
              testID="todo-calendar-add"
              onPress={() => props.onAddTask?.()}
            />
          </If>
        </View>
        <View class="flex-row items-center justify-between gap-3">
          <Text class="text-base font-semibold text-foreground" testID="todo-calendar-month">
            {monthTitle()}
          </Text>
          <View class="flex-row items-center gap-0.5">
            <Button variant="plain" iconOnly icon="PhCalendarDot" title={t("todo_calendar_today")} onPress={showToday} />
            <Button variant="plain" iconOnly icon="PhCaretLeft" title={t("todo_calendar_previous")} onPress={() => setMonth(-1)} />
            <Button variant="plain" iconOnly icon="PhCaretRight" title={t("todo_calendar_next")} onPress={() => setMonth(1)} />
          </View>
        </View>
      </View>

      <View class="flex-row border-b border-line-faint">
        <Each of={weekdayLabels()}>
          {(label) => (
            <Text class={`flex-1 py-1.5 font-mono text-xs uppercase text-muted-foreground ${props.mobile ? "text-center" : "px-1.5"}`}>
              {label()}
            </Text>
          )}
        </Each>
      </View>

      <If
        when={!props.tasksLoading}
        else={<Skeleton rows={3} label={t("todo_view_calendar")} />}
      >
        <View class={`gap-px bg-line-faint ${props.mobile ? "" : "flex-1"}`}>
          <Each of={weeks()} key={(week) => week.key}>
            {(week) => (
              <View class={`flex-row gap-px ${props.mobile ? "h-14" : "min-h-28 flex-1"}`}>
                <Each of={week().days} key={(day) => day.key}>
                  {(day) => (
                    <View
                      role="cell"
                      accessibilityLabel={day().key}
                      accessibilityState={{ selected: day().key === selectedDate() }}
                      testID={`todo-calendar-day-${day().key}`}
                      onPress={() => selectDate(day())}
                      class={`flex-1 gap-0.5 p-1 ${day().inMonth ? "bg-card" : "bg-paper"} ${
                        day().key === selectedDate() ? "bg-selection" : ""
                      } ${props.mobile ? "items-center" : ""}`}
                    >
                      <View
                        class={`size-6 items-center justify-center rounded-(--radius) ${
                          day().isToday ? "bg-primary" : ""
                        }`}
                      >
                        <Text
                          class={`text-xs ${
                            day().isToday
                              ? "font-semibold text-primary-foreground"
                              : day().inMonth
                                ? "text-foreground"
                                : "text-muted-foreground"
                          }`}
                        >
                          {String(day().day)}
                        </Text>
                      </View>
                      <If
                        when={!props.mobile}
                        else={
                          <If when={entriesFor(day()).length > 0}>
                            <View class="flex-row items-center gap-0.5" accessibilityElementsHidden>
                              <Each of={entriesFor(day()).slice(0, 3)} key={(entry) => `${entry.task_id}:${entry.date}`}>
                                {(entry) => (
                                  <View class={`size-1 ${entry().task.enabled === false ? "bg-status-off" : "bg-blue"}`} />
                                )}
                              </Each>
                              <Text class="ml-0.5 text-xs text-muted-foreground">{String(entriesFor(day()).length)}</Text>
                            </View>
                          </If>
                        }
                      >
                        <Each of={entriesFor(day()).slice(0, 3)} key={(entry) => `${entry.task_id}:${entry.date}`}>
                          {(entry) => <EntryButton entry={entry} meta={entryCellMeta} />}
                        </Each>
                        <If when={entriesFor(day()).length > 3}>
                          <Popover
                            open={expandedDate() === day().key}
                            onOpenChange={({ open }) => {
                              if (!open && untracked(expandedDate) === untracked(day).key) expandedDate.set("");
                            }}
                            placement="bottom"
                            align="start"
                            popupClass="w-64 gap-1 rounded-(--radius) border border-border bg-popover p-2 shadow-md"
                            trigger={
                              <BaseButton
                                onPress={() => toggleOverflow(day())}
                                class="self-start rounded-(--radius) px-1 hover:bg-hover"
                              >
                                <Text class="text-xs text-blue">
                                  {t("todo_calendar_more", { count: entriesFor(day()).length - 3 })}
                                </Text>
                              </BaseButton>
                            }
                          >
                            <Text class="px-1 font-mono text-xs text-muted-foreground">{day().key}</Text>
                            <Each of={entriesFor(day())} key={(entry) => `${entry.task_id}:${entry.date}`}>
                              {(entry) => <EntryButton entry={entry} meta={entryCellMeta} />}
                            </Each>
                          </Popover>
                        </If>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
        <If when={isEmpty()}>
          <View class="items-center gap-1 py-4">
            <Text class="text-sm font-medium text-foreground">{t("todo_calendar_empty")}</Text>
            <Text class="text-xs text-muted-foreground">{t("todo_calendar_empty_hint")}</Text>
          </View>
        </If>
      </If>

      <If when={props.mobile}>
        <View class="gap-2 pt-3" accessibilityLabel={t("todo_calendar_agenda")}>
          <View class="border-b border-line pb-2">
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
