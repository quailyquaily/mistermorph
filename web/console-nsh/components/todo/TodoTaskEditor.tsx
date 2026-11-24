// The editor of one TODO item (the task editor card of web/console/src/views/TodoView.js, styled as
// views/TodoView.css): a boxed card whose head is the enabled switch, Stop (while the item runs),
// Save and the action menu; then the title, the content, the timezone / schedule / model / chat
// pickers, the date or the repeat, the preview sentence, the workspace directory and the bash
// environment.
//
// The form follows its own width as the Vue form's container queries do: the four pickers stand one
// per row under 720pt, two from 720, four from 1120; the weekly controls put the time beside the
// weekdays above 680; the weekday chips run 7 to a row, 4 in a narrow form or window, 2 on a phone.
import type { JSX } from "nsh";
import { signal, Text, View, windowSize } from "nsh";
import { Button as BaseButton, Switch, TimeField } from "nsh/base";
import { CALENDAR_DAY_CLASS, DateField } from "../shared/DateField";
import { currentLocale, formatTime, translate } from "../../lib/core/context.js";
import { formatDate } from "../../lib/core/intl-format.js";
import { AppMarkdownEditor } from "../shared/MarkdownEditor";
import { Button, BusyBeam, busyLook, DropdownMenu, Icon, MENU_POPUP_STYLE, type MenuEntry, SWITCH_THUMB_CLASS, SWITCH_TRACK_CLASS, switchThumbStyle, Tabs, Tip, TipButton } from "../ui";
import { CONTROL_CORNERS, POPOVER_CORNERS } from "../corners";
import * as model from "./todo-model.js";
import { TodoJobButton } from "../chat/TodoJobBar";
import { CapsuleToolbar, capsuleToolbarSize } from "../shared/CapsuleBar";
import { isMobile } from "../../lib/shell";
import { TodoCard } from "./TodoCard";
import { FIELD_FOCUS, FIELD_FRAME, FIELD_PAD, FIELD_TRANSITION, FieldNote, Prepend, TodoInput } from "./TodoFields";
import { TodoRuns } from "./TodoRuns";
import { TodoSelect } from "./TodoSelect";
import type { TodoState, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

// The preview and the bash environment are boxed (`.todo-task-preview`): line-soft 76 % on paper
// 94 %, 4pt corners, 11/12/12 padding; their labels are 14pt semibold blue.
const INSET_BOX = "rounded-[4px] border border-line-soft/75 bg-paper/95 px-3 pb-3 pt-[11px]";
const INSET_LABEL = "text-sm font-semibold leading-[18.9px] text-blue";


/**
 * A field whose shown value the model may normalize: rebuilt when the page asks (repeatInputRevision),
 * so a typed value the model changed (75 minutes, day 0) shows the normalized one. The Vue view also
 * keyed it by the value; here the controlled value follows by itself, and the field keeps its focus.
 */
function NormalizedField(props: {
  revisionKey: string;
  value: string;
  prepend: string;
  label: string;
  disabled?: boolean;
  testID?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Each of={[props.revisionKey]}>
      {() => (
        <TodoInput
          value={props.value}
          onChange={(value) => props.onChange(value)}
          prepend={props.prepend}
          keyboardType="number-pad"
          accessibilityLabel={props.label}
          disabled={props.disabled}
          testID={props.testID}
        />
      )}
    </Each>
  );
}

/** A weekday chip (`.todo-weekday`): a box with the controls' corners that turns blue when chosen. */
function WeekdayChip(props: { day: number; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <BaseButton
      onPress={() => props.onPress()}
      selected={props.selected}
      disabled={props.disabled}
      accessibilityLabel={model.weekdayLabel(props.day) as string}
      testID={`todo-weekday-${props.day}`}
      class={`h-11 flex-1 items-center justify-center ${CONTROL_CORNERS} border px-1.5 disabled:opacity-50 ${
        props.selected ? "border-blue/60 bg-blue/12" : "border-line/70 bg-paper/95 hover:border-blue/45 hover:bg-hover"
      }`}
      style={{ transitionProperty: "colors", transitionDuration: 160, transitionTimingFunction: "ease" }}
    >
      <Text
        class={`text-xs font-medium leading-[14.4px] ${props.selected ? "text-blue" : "text-subtle"}`}
        style={{ numberOfLines: 1 }}
      >
        {model.weekdayLabel(props.day) as string}
      </Text>
    </BaseButton>
  );
}

/** The run-at date and time (Vue's AppDatetimePicker with its "Run At" prepend): one field, date then time. */
function RunAtField(props: { task: TodoTask; disabled: boolean; onChange: (value: string) => void }) {
  const parts = () => {
    const value = String(model.atInputValue(props.task) || "");
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return { date: value.slice(0, 10), time: value.slice(11, 16) };
    return {
      date: formatDate(date, currentLocale(), { year: "numeric", month: "2-digit", day: "2-digit" }),
      time: formatDate(date, currentLocale(), { hour: "2-digit", minute: "2-digit" }),
    };
  };
  return (
    <DateField
      value={model.atInputValue(props.task) || null}
      timePrecision="minute"
      disabled={props.disabled}
      accessibilityLabel={t("todo_field_at")}
      timeAccessibilityLabel={t("todo_field_time")}
      testID="todo-at"
      onChange={({ value }) => {
        if (typeof value === "string") props.onChange(value);
      }}
      offset={4}
      popupClass={`${POPOVER_CORNERS} border border-line-faint bg-dialog p-3`}
      popupStyle={{ boxShadow: MENU_POPUP_STYLE.boxShadow }}
      backdropClass="bg-scrim"
      headerClass="flex-row items-center justify-between pb-2"
      rowClass="flex-row justify-between"
      itemClass={CALENDAR_DAY_CLASS}
      timeClass="mt-2 flex-row items-center justify-between gap-3"
      timeLabel={<Text class="text-sm text-subtle">{t("todo_field_time")}</Text>}
      timeFieldClass={`h-9.5 flex-row items-center ${CONTROL_CORNERS} border border-input bg-field px-3`}
      segmentClass="rounded-(--radius) px-0.5 text-sm text-foreground focus:bg-selection"
      separatorClass="text-sm text-muted-foreground"
      trigger={
        <View
          class={`${FIELD_FRAME} ${FIELD_PAD} pr-3 hover:border-outline-line-hover ${props.disabled ? "opacity-50" : ""}`}
          style={FIELD_TRANSITION}
        >
          <Prepend medium>{t("todo_field_at")}</Prepend>
          <View class="flex-1 flex-row items-center gap-2 pl-1">
            <Text class="flex-1 text-sm tabular-nums text-foreground">{parts().date}</Text>
            <Icon name="PhCalendarBlank" size={16} color="foreground" />
          </View>
          <View class="flex-1 flex-row items-center gap-2 pl-4">
            <Text class="flex-1 text-sm tabular-nums text-foreground">{parts().time}</Text>
          </View>
        </View>
      }
    />
  );
}

/** The repeat time, edited a segment at a time, inside the field frame with its "Time" prepend. */
function RepeatTimeField(props: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <View class={`${FIELD_FRAME} ${FIELD_PAD} ${props.disabled ? "opacity-50" : ""}`} focusWithinStyle={FIELD_FOCUS} style={FIELD_TRANSITION}>
      <Prepend>{t("todo_field_time")}</Prepend>
      <TimeField
        value={props.value}
        hourCycle={localeHourCycle()}
        disabled={props.disabled}
        accessibilityLabel={t("todo_field_time")}
        testID="todo-repeat-time"
        onChange={({ value }) => props.onChange(value)}
        class="flex-1 flex-row items-center pl-0.5"
        segmentClass="rounded-(--radius) text-sm tabular-nums text-foreground focus:bg-selection"
        separatorClass="text-sm text-foreground"
        // A space before AM / PM, as the browser's time field writes it.
        renderSegment={(entry) => (
          <Text class="text-sm tabular-nums text-foreground">{entry.segment === "period" ? ` ${entry.label}` : entry.label}</Text>
        )}
      />
    </View>
  );
}

/** 12 or 24 hours, as the locale writes a time (the Vue field is the browser's time input, which does). */
function localeHourCycle(): "h12" | "h23" {
  try {
    const cycle = new Intl.DateTimeFormat(currentLocale(), { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12" ? "h12" : "h23";
  } catch {
    return "h23";
  }
}

/** The head's switch: the track alone, as the Vue head draws it; its name is its tooltip. */
function EnabledSwitch(props: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; label?: string; testID?: string }) {
  // ui.tsx's Toggle always draws its label beside the track; the head shows the track alone, with
  // Toggle's classes (styles/ui-kit.css .q-switch in the morph theme).
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      accessibilityLabel={props.label ?? t("todo_field_enabled")}
      tooltip={props.label ? undefined : <Tip text={t("todo_field_enabled")} />}
      testID={props.testID ?? "todo-enabled"}
      class="group flex-row items-center disabled:opacity-50"
      trackClass={SWITCH_TRACK_CLASS}
      thumbClass={SWITCH_THUMB_CLASS}
      thumbStyle={switchThumbStyle()}
    />
  );
}

/**
 * A block of the job's sheet: its name in the margin (a small mono label, as a notebook's margin
 * note) and what it holds beside it; on a narrow window the name sits above.
 */
function SheetBlock(props: { label: string; stacked: boolean; children?: JSX.Element }) {
  return (
    <View class={props.stacked ? "gap-1.5" : "flex-row gap-4"} accessibilityLabel={props.label} role="group">
      <Text
        class={`font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[1.1px] text-muted-foreground ${props.stacked ? "" : "w-16 pt-[14px]"}`}
        role="header"
      >
        {props.label}
      </Text>
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

/** A phone: the job's toolbar floats at the page's foot, where the bottom navigation does, not in the bar. */
export function todoToolbarAtFoot(): boolean {
  return isMobile();
}

/**
 * The open job's runs stand in a column of their own beside its page, as the list's Today column
 * stands beside the list (a window with room for it, a saved job, a runtime that keeps runs);
 * else they follow the form.
 */
export function todoRunsBeside(state: TodoState): boolean {
  const task = state.selectedTask();
  return state.sideRoom() && Boolean(task?.id) && Boolean(model.knowsTriggers(task));
}

/** A job's actions as the editor's menu draws them. */
function jobMenuItems(state: TodoState): MenuEntry[] {
  return state.taskActionMenuItems().map((item) =>
    item.divider
      ? { id: item.id, separator: true }
      : {
          id: item.id,
          label: item.title,
          danger: item.danger,
          disabled: item.disabled,
          onSelect: item.action,
        },
  );
}

/** The open job's enabled switch: the track alone, named by its tooltip. In the job page's bar. */
export function TodoEnabledSwitch(props: { state: TodoState }) {
  const state = props.state;
  return (
    <If when={state.selectedTask()}>
      {(task) => (
        <EnabledSwitch checked={task().enabled !== false} disabled={state.locked()} onChange={(checked) => state.edits.enabled(task(), checked)} />
      )}
    </If>
  );
}

/**
 * The open job's toolbar, the one its topic has (TodoJobBar): Start or Stop, the way to the other
 * page (here the topic), and the remaining actions as its last slot. `compact`: set into the page's
 * bar, as tall as the bar's back button, with no shadow. Else it floats at a phone page's foot: the
 * bottom navigation's capsule (GlassCapsule), at the topic toolbar's size.
 */
export function TodoJobToolbar(props: { state: TodoState; compact?: boolean }) {
  const state = props.state;
  const size = () => capsuleToolbarSize(!!props.compact);
  const starting = () => state.runningTaskKey() === state.selectedTask()?._key;
  const items = () => jobMenuItems(state).filter((item) => item.id !== "run-manually" && item.id !== "open-topic");
  return (
    // The shared capsule toolbar: set into the bar at the compact size, else floating at the navigation's.
    <CapsuleToolbar floating={!props.compact} compact={props.compact} label={t("chat_todo_job_toolbar")} testID="todo-toolbar">
      <If
        when={state.selectedRunStop()}
        else={
          <TodoJobButton
            kind="start"
            label={t("chat_todo_job_start")}
            busy={starting()}
            disabled={!state.canRunSelectedTask()}
            onPress={() => void state.runSelectedTaskNow()}
            size={size()}
            testID="todo-run"
          />
        }
      >
        {(stop) => (
          <TodoJobButton
            kind="stop"
            label={stop().pending ? t("todo_action_stopping") : t("chat_todo_job_stop")}
            busy={stop().pending}
            onPress={() => void state.stopSelectedRun()}
            size={size()}
            testID="todo-stop"
          />
        )}
      </If>
      <TodoJobButton
        kind="topic"
        label={t("todo_action_open_topic")}
        disabled={!state.selectedTaskTopicID()}
        onPress={() => state.openTaskTopic(state.selectedTaskTopicID())}
        size={size()}
        testID="todo-open-topic"
      />
      <DropdownMenu
        disabled={state.locked()}
        items={items()}
        testID="todo-task-actions"
        trigger={
          <View
            testID="todo-task-actions"
            accessibilityLabel={t("todo_action_more")}
            role="button"
            tooltip={<Tip text={t("todo_action_more")} />}
            class="items-center justify-center rounded-full hover:bg-hover"
            style={{ width: size().width, height: size().height, transitionProperty: "colors", transitionDuration: 160 }}
          >
            <Icon name="PhDotsThree" size={size().icon} color="muted-foreground" />
          </View>
        }
      />
    </CapsuleToolbar>
  );
}

/** A picker's width in a form `width` wide with `columns` to a row and 12pt between them. */
function pickerWidth(width: number, columns: number): number | `${number}%` {
  if (width <= 0) return "100%";
  return Math.floor(((width - 12 * (columns - 1)) / columns) * 100) / 100;
}

export function TodoTaskEditor(props: { state: TodoState; panel?: boolean }) {
  const state = props.state;
  const task = () => state.selectedTask() as TodoTask;
  // The form takes no edits while the list loads; the page's own saves leave it open.
  const busy = () => state.locked();
  const taskStarting = () => state.runningTaskKey() === task()._key;
  const kind = () => model.repeatKind(task()) as string;
  const formWidth = signal(0);
  const pickerColumns = () => (formWidth() >= 1120 ? 4 : formWidth() >= 720 ? 2 : 1);
  const narrowWindow = () => windowSize().width <= 760;
  // The repeat controls side by side: the weekly ones above a 680 form, the others (time or minute,
  // and the month's day) wherever the window is wider than 760.
  const controlsInRow = () => !narrowWindow() && (kind() !== "weekly" || formWidth() > 680);
  const weekdayColumns = () => (windowSize().width <= 620 ? 2 : formWidth() <= 680 || windowSize().width <= 1080 ? 4 : 7);
  const weekdayRows = () => {
    const days = model.WEEKDAYS as { value: number }[];
    const n = weekdayColumns();
    const rows: (number | null)[][] = [];
    for (let i = 0; i < days.length; i += n) {
      const row: (number | null)[] = days.slice(i, i + n).map((day) => day.value);
      while (row.length < n) row.push(null);
      rows.push(row);
    }
    return rows;
  };

  const menuItems = () => jobMenuItems(state);

  const scheduleModes = () =>
    (model.scheduleModeItems() as { id: string; title: string; value: string }[]).filter((item) => item.value !== "none" || model.knowsTriggers(task()));
  const previewSegments = () => model.previewSegments(task()) as { type: string; text: string }[];
  const previewError = () => Boolean(model.schedulePreviewError(task()));
  const pickerStyle = () => ({ width: pickerWidth(formWidth(), pickerColumns()) });

  const enabledSwitch = () => (
    <>
        <EnabledSwitch
          checked={task().enabled !== false}
          disabled={busy()}
          onChange={(checked) => state.edits.enabled(task(), checked)}
        />
    </>
  );
  const actions = () => (
    <>
        <View class="flex-row items-center gap-1">
          {/* Only while the saved item runs: stops that one run, never the item or its schedule.
              Busy from the press until the run's end shows. */}
          <If when={state.selectedRunStop()}>
            {(stop) => (
              <Button
                variant="outlined"
                size="xs"
                icon="PhStop"
                label={stop().pending ? t("todo_action_stopping") : t("todo_action_stop")}
                title={t("todo_stop_hint")}
                loading={stop().pending}
                testID="todo-stop"
                onPress={() => void state.stopSelectedRun()}
              />
            )}
          </If>
          <DropdownMenu
            disabled={busy()}
            items={menuItems()}
            testID="todo-task-actions"
            trigger={
              // While the task's run is being started from this menu, a busy plain button (BusyBeam).
              <View
                testID="todo-task-actions"
                accessibilityLabel={t("todo_action_more")}
                role="button"
                tooltip={<Tip text={t("todo_action_more")} />}
                class={`relative size-8 items-center justify-center ${CONTROL_CORNERS} ${taskStarting() ? "" : "hover:bg-hover"}`}
                style={{ transitionProperty: "colors", transitionDuration: 180 }}
              >
                <Icon name="PhDotsThree" size={16} color={taskStarting() ? busyLook("plain").text : "subtle"} />
                <BusyBeam busy={taskStarting()} variant="plain" short testID="todo-task-actions-beam" />
              </View>
            }
          />
        </View>
    </>
  );
  const titleField = () => (
    <>
        <TodoInput
          value={task().title}
          onChange={(value) => state.edits.title(task(), value)}
          placeholder={t("todo_untitled")}
          accessibilityLabel={t("todo_field_title")}
          disabled={busy()}
          strong
          testID="todo-title"
        />
    </>
  );
  const contentField = () => (
    <>
          {/* A regular textarea with the mention and conversation toolbar: the content as written,
              no Markdown highlighting or preview. */}
          <AppMarkdownEditor
            plainText
            documentKey={task()._key}
            value={task().content}
            // clamp(168px, 26vh, 320px), worked out here: the shared editor reads a clamp as its max.
            height={Math.round(Math.min(320, Math.max(168, windowSize().height * 0.26)))}
            placeholder={t("todo_content_placeholder")}
            accessibilityLabel={t("todo_field_content")}
            disabled={busy()}
            testID="todo-content"
            onChange={(value) => state.edits.field(task(), "content", value)}
          />
    </>
  );
  const tzPicker = () => (
    <>
            <View style={pickerStyle()}>
              <TodoSelect
                label={t("todo_field_timezone")}
                items={model.timezoneBaseItems()}
                current={model.timezoneItem(task())}
                placeholder={t("todo_timezone_placeholder")}
                searchable
                disabled={busy()}
                testID="todo-timezone"
                onChange={(value) => state.edits.timezone(task(), value)}
              />
            </View>
    </>
  );
  const modePicker = () => (
    <>
            <View style={pickerStyle()}>
              <TodoSelect
                label={t("todo_field_schedule")}
                items={scheduleModes()}
                current={scheduleModes().find((item: { value: string }) => item.value === model.taskMode(task()))}
                placeholder={t("todo_field_schedule")}
                disabled={busy()}
                testID="todo-schedule-mode"
                onChange={(value) => state.edits.scheduleMode(task(), value)}
              />
            </View>
    </>
  );
  const llmPicker = (fill?: boolean) => (
    <>
            <View class={fill ? "min-w-0 flex-1" : ""} style={fill ? undefined : pickerStyle()}>
              <TodoSelect
                label={t("todo_field_llm_profile")}
                items={state.llmProfileMenuItems()}
                current={model.llmProfileItem(state.llmProfileMenuItems(), task())}
                placeholder={t("todo_llm_profile_placeholder")}
                searchable
                hideSelectedMedia
                disabled={busy()}
                testID="todo-llm-profile"
                onChange={(value) => state.edits.llmProfile(task(), value)}
              />
            </View>
    </>
  );
  const chatPicker = () => (
    <>
            <View style={pickerStyle()}>
              <TodoSelect
                label={t("todo_field_chat")}
                items={state.chatMenuItems()}
                current={model.chatItem(state.chatMenuItems(), task())}
                placeholder={t("todo_chat_placeholder")}
                searchable
                hideSelectedMedia
                disabled={busy()}
                testID="todo-chat"
                onChange={(value) => void state.edits.chat(task(), value)}
              />
            </View>
    </>
  );
  const scheduleControls = () => (
    <>
          <If
            when={model.taskMode(task()) === "once"}
            else={
              <View class="gap-2.5">
                <Tabs
                  equal
                  accessibilityLabel={t("todo_field_repeat")}
                  class={busy() ? "opacity-60" : ""}
                  items={model.repeatKindTabs().map((tab: { id: string; title: string }) => ({
                    id: tab.id,
                    label: tab.title,
                    disabled: busy(),
                  }))}
                  value={kind()}
                  onChange={(id) => state.edits.repeatKind(task(), id)}
                />
                <If
                  when={kind() !== "custom"}
                  else={
                    <View class="gap-[5px]">
                      <TodoInput
                        value={task().custom_cron}
                        onChange={(value) => state.edits.customCron(task(), value)}
                        placeholder={t("todo_custom_cron_placeholder")}
                        accessibilityLabel={t("todo_field_cron")}
                        disabled={busy()}
                        testID="todo-custom-cron"
                      />
                      <FieldNote>{t("todo_custom_cron_note")}</FieldNote>
                    </View>
                  }
                >
                  <View class={`gap-3 ${controlsInRow() ? "flex-row items-start" : ""}`}>
                    <View class={controlsInRow() ? (kind() === "weekly" ? "min-w-35 flex-1" : "min-w-45 flex-1") : ""}>
                      <If
                        when={kind() === "hourly"}
                        else={
                          <RepeatTimeField
                            value={task().repeat_time || "09:00"}
                            disabled={busy()}
                            onChange={(value) => state.edits.repeatTime(task(), value)}
                          />
                        }
                      >
                        <NormalizedField
                          revisionKey={`minute-${task()._key}-${state.repeatInputRevision()}`}
                          value={model.repeatMinuteValue(task()) as string}
                          prepend={t("todo_field_minute")}
                          label={t("todo_field_minute")}
                          disabled={busy()}
                          testID="todo-repeat-minute"
                          onChange={(value) => state.edits.repeatMinute(task(), value)}
                        />
                      </If>
                    </View>

                    <If when={kind() === "weekly"}>
                      <View
                        class={`gap-1.5 ${controlsInRow() ? "flex-[3]" : ""}`}
                        accessibilityLabel={t("todo_field_weekdays")}
                        role="group"
                      >
                        <Each of={weekdayRows()}>
                          {(row) => (
                            <View class="flex-row gap-1.5">
                              <Each of={row()}>
                                {(day) => (
                                  <If when={day() !== null} else={<View class="flex-1" />}>
                                    <WeekdayChip
                                      day={day()!}
                                      selected={Boolean(model.weekdaySelected(task(), day()))}
                                      disabled={busy()}
                                      onPress={() => state.edits.toggleWeekday(task(), day()!)}
                                    />
                                  </If>
                                )}
                              </Each>
                            </View>
                          )}
                        </Each>
                      </View>
                    </If>

                    <If when={kind() === "monthly"}>
                      <View class={controlsInRow() ? "min-w-45 flex-1" : ""}>
                        <NormalizedField
                          revisionKey={`month-day-${task()._key}-${state.repeatInputRevision()}`}
                          value={task().repeat_month_day}
                          prepend={t("todo_field_day")}
                          label={t("todo_field_month_day")}
                          disabled={busy()}
                          testID="todo-repeat-month-day"
                          onChange={(value) => state.edits.repeatMonthDay(task(), value)}
                        />
                      </View>
                    </If>
                  </View>
                </If>
              </View>
            }
          >
            <RunAtField task={task()} disabled={busy()} onChange={(value) => state.edits.at(task(), value)} />
          </If>
    </>
  );
  const preview = () => (
    <>
          {/* The schedule said in words: a line under the controls it reads back, not a surface of
              its own (no frame, no heading; its place says what it is, and its name is read out).
              One cue for the words that come from the form: they are in the text colour, the rest
              is quiet. An invalid schedule is the same line in the danger colour. */}
          <View class="pl-[13.8px] pr-1" accessibilityLabel={t("todo_repeat_preview")} testID="todo-preview">
            <Text class={`text-sm leading-[21.7px] ${previewError() ? "text-danger" : "text-muted-foreground"}`} role={previewError() ? "alert" : undefined}>
              <Each of={previewSegments()}>
                {(part) => (
                  <If when={part().type === "mark"} else={<Text>{part().text}</Text>}>
                    <Text class={previewError() ? "text-danger" : "text-foreground"}>{part().text}</Text>
                  </If>
                )}
              </Each>
            </Text>
          </View>
    </>
  );
  const lastRun = () => (
    <>
          <If when={model.taskLastRun(task(), formatTime)}>
            {(lastRun) => (
              <Text
                testID="todo-last-run"
                class={`text-xs leading-[17.4px] ${lastRun().status === "failed" ? "text-danger" : "text-muted-foreground"}`}
              >
                {lastRun().label}
              </Text>
            )}
          </If>
    </>
  );
  const workspace = () => (
    <>
          <View class="gap-[5px]">
            <TodoInput
              value={task().workspace_dir}
              onChange={(value) => state.edits.workspaceDir(task(), value)}
              prepend={t("todo_field_workspace_dir")}
              placeholder={t("todo_workspace_dir_placeholder")}
              accessibilityLabel={t("todo_field_workspace_dir")}
              disabled={busy()}
              testID="todo-workspace-dir"
              trailing={
                <View class="flex-row items-center">
                  <If when={task().workspace_dir}>
                    <Button
                      variant="plain"
                      size="sm"
                      iconOnly
                      icon="PhX"
                      title={t("todo_workspace_dir_clear")}
                      disabled={busy()}
                      testID="todo-workspace-clear"
                      onPress={() => state.edits.clearWorkspaceDir(task())}
                    />
                  </If>
                  <Button
                    variant="plain"
                    size="sm"
                    iconOnly
                    icon="PhFolderOpen"
                    title={t("todo_workspace_dir_browse")}
                    disabled={busy()}
                    testID="todo-workspace-browse"
                    onPress={state.openWorkspacePicker}
                  />
                </View>
              }
            />

          </View>
    </>
  );
  const bashEnv = () => (
    <>
          <View class={`gap-2.5 ${INSET_BOX}`}>
            <View class="gap-1">
              <Text class={INSET_LABEL}>{t("todo_field_bash_env")}</Text>
              <FieldNote>{t("todo_bash_env_hint")}</FieldNote>
            </View>
            <If when={model.hasBashEnvRows(task())}>
              <View class="gap-2">
                <Each of={task().bash_env.map((_, index) => index)}>
                  {(index) => (
                    <View class={narrowWindow() ? "gap-2" : "flex-row items-start gap-2"}>
                      <View class={narrowWindow() ? "" : "min-w-30 flex-[0.8]"}>
                        <TodoInput
                          value={task().bash_env[index()]?.name ?? ""}
                          onChange={(value) => state.edits.bashEnvField(task(), index(), "name", value)}
                          placeholder={t("todo_bash_env_name")}
                          accessibilityLabel={t("todo_bash_env_name")}
                          disabled={busy()}
                          testID={`todo-bash-env-name-${index()}`}
                        />
                      </View>
                      <View class={narrowWindow() ? "" : "flex-[1.6]"}>
                        <TodoInput
                          value={task().bash_env[index()]?.value ?? ""}
                          onChange={(value) => state.edits.bashEnvField(task(), index(), "value", value)}
                          placeholder={t("todo_bash_env_value")}
                          accessibilityLabel={t("todo_bash_env_value")}
                          disabled={busy()}
                          testID={`todo-bash-env-value-${index()}`}
                        />
                      </View>
                      <Button
                        variant="plain"
                        size="md"
                        iconOnly
                        icon="PhTrash"
                        title={t("action_delete")}
                        disabled={busy()}
                        testID={`todo-bash-env-remove-${index()}`}
                        class={narrowWindow() ? "self-end" : ""}
                        onPress={() => state.edits.removeBashEnvRow(task(), index())}
                      />
                    </View>
                  )}
                </Each>
              </View>
            </If>
            {/* The ui-kit's "placeholder" button: a dashed blue hairline on translucent white. */}
            <TipButton
              onPress={() => state.edits.addBashEnvRow(task())}
              disabled={busy()}
              accessibilityLabel={t("todo_bash_env_add")}
              tooltip={<Tip text={t("todo_bash_env_add")} />}
              testID="todo-bash-env-add"
              class={`h-9.5 flex-row items-center justify-center gap-2 ${CONTROL_CORNERS} border border-dashed border-blue/35 bg-outline-bg hover:border-blue/60 hover:bg-outline-bg-hover disabled:opacity-50`}
              style={{ transitionProperty: "colors", transitionDuration: 180 }}
            >
              <Icon name="PhPlus" size={16} color="subtle" />
            </TipButton>
          </View>
    </>
  );

  // What else starts it besides the form's schedule, as the job already has it (a poke URL or a chat's
  // messages set through the agent or the API, further schedules). They are listed and can be
  // removed; none is added here: a poke or a message names a job with [label](job:<id>) instead.
  const extras = () => model.extraTriggers(task()) as { id: string; kind: string; at: string; cron: string; tz: string; channel: string; chat_id: string }[];
  const triggers = () => (
    <View class="gap-2.5" testID="todo-triggers">
      <Each of={extras().map((item, index) => ({ item, index }))} key={(entry) => `${entry.index}:${entry.item.kind}:${entry.item.chat_id}:${entry.item.cron}:${entry.item.at}`}>
        {(entry) => (
          <View class="min-h-11 flex-row items-center gap-2" testID={`todo-trigger-${entry().index}`}>
            <Text class="min-w-0 flex-1 text-sm leading-[21px] text-foreground">{state.triggerPhrase(entry().item)}</Text>
            <Button
              variant="plain"
              size="sm"
              iconOnly
              icon="PhX"
              title={t("todo_trigger_remove")}
              disabled={busy()}
              testID={`todo-trigger-${entry().index}-remove`}
              onPress={() => state.edits.removeExtraTrigger(task(), entry().index)}
            />
          </View>
        )}
      </Each>
    </View>
  );

  // The jobs whose results this one takes in (each finished run of one starts this job), and the
  // jobs that take in this one's. There is one way to use a job, so nothing to choose per job.
  const uses = () => (
    <View class="gap-2.5" testID="todo-uses">
      <Each of={task().uses ?? []} key={(use) => use.job_id}>
        {(use) => (
          <View class="flex-row items-center gap-2" testID={`todo-use-${use().job_id}`}>
            <BaseButton
              onPress={() => state.openJob(use().job_id)}
              accessibilityLabel={state.jobTitle(use().job_id)}
              class="min-h-11 min-w-0 flex-1 justify-center rounded-(--radius) px-1 hover:bg-hover-soft"
            >
              <Text class="text-sm leading-[21px] text-foreground" style={{ numberOfLines: 1 }}>
                {state.jobTitle(use().job_id)}
              </Text>
            </BaseButton>
            <Button
              variant="plain"
              size="sm"
              iconOnly
              icon="PhX"
              title={t("todo_use_remove", { title: state.jobTitle(use().job_id) })}
              disabled={busy()}
              testID={`todo-use-${use().job_id}-remove`}
              onPress={() => state.edits.removeUse(task(), use().job_id)}
            />
          </View>
        )}
      </Each>
      <If when={(task().uses ?? []).length > 1}>
        <View style={pickerStyle()}>
          <TodoSelect
            label={t("todo_join")}
            items={state.joinItems()}
            current={state.joinItems().find((item) => item.value === (task().join || "all"))}
            placeholder={t("todo_join")}
            disabled={busy()}
            testID="todo-join"
            onChange={(value) => state.edits.join(task(), value)}
          />
        </View>
      </If>
      <Each of={task().warnings ?? []}>
        {(warning) => <Text class="text-xs leading-[17.4px] text-warn-dark" role="alert">{warning()}</Text>}
      </Each>
      <If when={state.usableJobItems(task()).length > 0}>
        <View style={pickerStyle()}>
          <TodoSelect
            label={t("todo_use_add")}
            items={state.usableJobItems(task())}
            current={null}
            placeholder={t("todo_use_add_placeholder")}
            searchable
            disabled={busy()}
            testID="todo-use-add"
            onChange={(value) => state.edits.addUse(task(), value)}
          />
        </View>
      </If>
    </View>
  );
  const usedBy = () => (
    <View testID="todo-used-by">
      <Each of={state.usedBy(task())} key={(entry) => entry.id}>
        {(entry) => (
          <BaseButton
            onPress={() => state.openJob(entry().id)}
            accessibilityLabel={entry().title}
            testID={`todo-used-by-${entry().id}`}
            class="min-h-11 flex-row items-center gap-3 rounded-(--radius) px-1 hover:bg-hover-soft"
          >
            <Text class="min-w-0 flex-1 text-sm leading-[21px] text-foreground" style={{ numberOfLines: 1 }}>
              {entry().title}
            </Text>
          </BaseButton>
        )}
      </Each>
    </View>
  );

  // In the calendar's side column the job is a card, as before. As a page it is a sheet of labelled
  // blocks: when it runs, what it does, whom it tells, what it uses, and its settings.
  const stacked = () => narrowWindow();
  // The run history is there (in the page's own column, or after the blocks): it replaces the
  // single last-run line.
  const runsShown = () => state.jobRunsAvailable() && Boolean(task().id) && Boolean(model.knowsTriggers(task()));
  return (
    <If
      when={props.panel}
      else={
        <View class="pb-10" accessibilityLabel={t("todo_detail_title")} testID="todo-task-editor">
          {/* The title and the blocks; the job's runs follow them where the page has no column for them. */}
          <View class="gap-7">
            <View class="min-w-0 gap-7">
          <View class="gap-2">
            {titleField()}
            <If when={!runsShown()}>{lastRun()}</If>
          </View>
              <SheetBlock label={t("todo_block_when")} stacked={stacked()}>
                <View class="gap-3" onLayout={(event) => formWidth.set(event.bounds.size.width)}>
                  <View class="flex-row flex-wrap gap-3">
                    {modePicker()}
                    <If when={model.taskMode(task()) !== "none"}>{tzPicker()}</If>
                  </View>
                  <If when={model.taskMode(task()) !== "none"}>
                    {scheduleControls()}
                    {preview()}
                  </If>
                  <If when={model.knowsTriggers(task()) && extras().length > 0}>{triggers()}</If>
                </View>
              </SheetBlock>
              <SheetBlock label={t("todo_block_do")} stacked={stacked()}>
                {contentField()}
              </SheetBlock>
              <SheetBlock label={t("todo_block_tell")} stacked={stacked()}>
                {chatPicker()}
              </SheetBlock>
              <If when={model.knowsTriggers(task())}>
                <SheetBlock label={t("todo_block_uses")} stacked={stacked()}>
                  {uses()}
                </SheetBlock>
                <If when={state.usedBy(task()).length > 0}>
                  <SheetBlock label={t("todo_block_used_by")} stacked={stacked()}>
                    {usedBy()}
                  </SheetBlock>
                </If>
              </If>
              <SheetBlock label={t("todo_block_set")} stacked={stacked()}>
                <View class="gap-3">
                  {/* The model and the directory share a row where there is room for both. */}
                  <If
                    when={!stacked()}
                    else={
                      <>
                        {llmPicker()}
                        {workspace()}
                      </>
                    }
                  >
                    <View class="flex-row items-start gap-3">
                      {llmPicker(true)}
                      <View class="min-w-0 flex-1">{workspace()}</View>
                    </View>
                  </If>
                  {bashEnv()}
                </View>
              </SheetBlock>
            </View>
            <If when={task().id && model.knowsTriggers(task()) && !todoRunsBeside(state)}>
              <TodoRuns
                jobID={task().id}
                title={t("todo_runs_title")}
                jobTitle={state.jobTitle}
                watch={state.liveRuns}
                onAvailable={(available) => state.jobRunsAvailable.set(available)}
              />
            </If>
          </View>
        </View>
      }
    >
      <TodoCard
        panel={props.panel}
        accessibilityLabel={t("todo_detail_title")}
        testID="todo-task-editor"
        lead={enabledSwitch()}
        actions={actions()}
      >
        <View class="gap-4">
          {titleField()}
          <View class="gap-3" onLayout={(event) => formWidth.set(event.bounds.size.width)}>
            {contentField()}
            <View class="flex-row flex-wrap gap-3">
              {tzPicker()}
              {modePicker()}
              {llmPicker()}
              {chatPicker()}
            </View>
            <If when={model.taskMode(task()) !== "none"}>
              {scheduleControls()}
              {preview()}
            </If>
            {lastRun()}
            {workspace()}
            {bashEnv()}
          </View>
        </View>
      </TodoCard>
    </If>
  );
}
