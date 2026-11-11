// The editor of one TODO item (the task editor card of web/console/src/views/TodoView.js, styled as
// views/TodoView.css): a boxed card whose head is the enabled switch, Stop (while the item runs),
// Save and the action menu; then the title, the content, the timezone / schedule / model / chat
// pickers, the date or the repeat, the preview sentence, the workspace directory and the bash
// environment.
//
// The form follows its own width as the Vue form's container queries do: the four pickers stand one
// per row under 720pt, two from 720, four from 1120; the weekly controls put the time beside the
// weekdays above 680; the weekday chips run 7 to a row, 4 in a narrow form or window, 2 on a phone.
import { signal, Text, View, windowSize } from "nsh";
import { Button as BaseButton, DatePicker, Switch, TimeField } from "nsh/base";
import { currentLocale, formatTime, translate } from "../../lib/core/context.js";
import { formatDate } from "../../lib/core/intl-format.js";
import { AppMarkdownEditor } from "../shared/MarkdownEditor";
import { bottomSheetStyle, Button, BusyBeam, busyLook, DropdownMenu, Icon, type MenuEntry, Tabs, Tip } from "../ui";
import * as model from "./todo-model.js";
import { TodoCard } from "./TodoCard";
import { FIELD_FOCUS, FIELD_FRAME, FIELD_PAD, FIELD_TRANSITION, FieldNote, Prepend, TodoInput } from "./TodoFields";
import { TodoSelect } from "./TodoSelect";
import type { TodoState, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

// The preview and the bash environment are boxed (`.todo-task-preview`): line-soft 76 % on paper
// 94 %, 4pt corners, 11/12/12 padding; their labels are 14pt semibold blue.
const INSET_BOX = "rounded-[4px] border border-line-soft/75 bg-paper-dense px-3 pb-3 pt-[11px]";
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

/** A weekday chip (`.todo-weekday`): a 4pt-cornered box that turns blue when chosen. */
function WeekdayChip(props: { day: number; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <BaseButton
      onPress={() => props.onPress()}
      selected={props.selected}
      disabled={props.disabled}
      accessibilityLabel={model.weekdayLabel(props.day) as string}
      testID={`todo-weekday-${props.day}`}
      class={`h-11 flex-1 items-center justify-center rounded-[4px] border px-1.5 disabled:opacity-60 ${
        props.selected ? "border-blue/55 bg-blue/12" : "border-line/70 bg-paper-dense hover:border-blue/40 hover:bg-hover"
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
    <DatePicker
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
      popupClass="rounded-(--radius) border border-line-faint bg-dialog p-3"
      popupStyle={bottomSheetStyle(12, { style: { boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 10px 24px rgba(24, 46, 72, 0.12)" } })}
      backdropClass="bg-scrim"
      headerClass="flex-row items-center justify-between pb-2"
      rowClass="flex-row justify-between"
      itemClass="h-8 min-w-8 items-center justify-center rounded-(--radius) text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      timeClass="mt-2 flex-row items-center justify-between gap-3"
      timeLabel={<Text class="text-sm text-subtle">{t("todo_field_time")}</Text>}
      timeFieldClass="h-9.5 flex-row items-center rounded-(--radius) border border-input bg-field px-3"
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
function EnabledSwitch(props: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  // ui.tsx's Toggle always draws its label beside the track; the head shows the track alone, with
  // Toggle's classes (styles/ui-kit.css .q-switch in the morph theme).
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      accessibilityLabel={t("todo_field_enabled")}
      tooltip={<Tip text={t("todo_field_enabled")} />}
      testID="todo-enabled"
      class="group flex-row items-center disabled:opacity-50"
      trackClass="h-5 w-[34px] rounded-(--radius) border border-line p-[2px] transition duration-180 group-hover:border-muted-foreground checked:border-ink checked:bg-ink"
      thumbClass="size-3.5 rounded-[1px] bg-card checked:translate-x-3.5"
      thumbStyle={{
        boxShadow: "0 0 0 1px rgba(24, 24, 50, 0.22), 0 1px 1px rgba(24, 24, 50, 0.1)",
        transitionProperty: "transform",
        transitionDuration: 260,
        transitionTimingFunction: "cubic-bezier(0.3, 1.35, 0.5, 1)",
      }}
    />
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
  const busy = () => state.saving() || state.loading();
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

  const menuItems = (): MenuEntry[] =>
    state.taskActionMenuItems().map((item) =>
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

  const previewSegments = () => model.previewSegments(task()) as { type: string; text: string }[];
  const previewError = () => Boolean(model.schedulePreviewError(task()));
  const pickerStyle = () => ({ width: pickerWidth(formWidth(), pickerColumns()) });

  return (
    <TodoCard
      panel={props.panel}
      accessibilityLabel={t("todo_detail_title")}
      testID="todo-task-editor"
      lead={
        <EnabledSwitch
          checked={task().enabled !== false}
          disabled={busy()}
          onChange={(checked) => state.edits.enabled(task(), checked)}
        />
      }
      actions={
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
          <Button
            variant="primary"
            size="xs"
            label={t("action_save")}
            disabled={!state.canSave()}
            loading={state.saving()}
            testID="todo-save"
            onPress={() => void state.save()}
          />
          <DropdownMenu
            disabled={busy()}
            items={menuItems()}
            trigger={
              // While the task's run is being started from this menu, a busy plain button (BusyBeam).
              <View
                testID="todo-task-actions"
                accessibilityLabel={t("todo_action_more")}
                role="button"
                tooltip={<Tip text={t("todo_action_more")} />}
                class={`relative size-8 items-center justify-center rounded-(--radius) ${taskStarting() ? "" : "hover:bg-hover"}`}
                style={{ transitionProperty: "colors", transitionDuration: 180 }}
              >
                <Icon name="PhDotsThree" size={16} color={taskStarting() ? busyLook("plain").text : "subtle"} />
                <BusyBeam busy={taskStarting()} variant="plain" short testID="todo-task-actions-beam" />
              </View>
            }
          />
        </View>
      }
    >
      <View class="gap-4">
        <TodoInput
          value={task().title}
          onChange={(value) => state.edits.title(task(), value)}
          placeholder={t("todo_untitled")}
          accessibilityLabel={t("todo_field_title")}
          disabled={busy()}
          strong
          testID="todo-title"
        />

        <View class="gap-3" onLayout={(event) => formWidth.set(event.bounds.size.width)}>
          <AppMarkdownEditor
            value={task().content}
            // clamp(168px, 26vh, 320px), worked out here: the shared editor reads a clamp as its max.
            height={Math.round(Math.min(320, Math.max(168, windowSize().height * 0.26)))}
            placeholder={t("todo_content_placeholder")}
            accessibilityLabel={t("todo_field_content")}
            disabled={busy()}
            testID="todo-content"
            onChange={(value) => state.edits.field(task(), "content", value)}
          />

          <View class="flex-row flex-wrap gap-3">
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
            <View style={pickerStyle()}>
              <TodoSelect
                label={t("todo_field_schedule")}
                items={model.scheduleModeItems()}
                current={model.scheduleModeItems().find((item: { value: string }) => item.value === model.taskMode(task()))}
                placeholder={t("todo_field_schedule")}
                disabled={busy()}
                testID="todo-schedule-mode"
                onChange={(value) => state.edits.scheduleMode(task(), value)}
              />
            </View>
            <View style={pickerStyle()}>
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
          </View>

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

          <View class={`gap-1.5 ${INSET_BOX} ${previewError() ? "border-danger/45 bg-danger/7" : ""}`} testID="todo-preview">
            <Text class={INSET_LABEL}>{t("todo_repeat_preview")}</Text>
            <Text class="text-sm leading-[21.7px] text-foreground">
              <Each of={previewSegments()}>
                {(part) => (
                  <If when={part().type === "mark"} else={<Text>{part().text}</Text>}>
                    {/* The marked words sit on a faint tint. The Vue mark also has 4pt of side
                        padding and 3pt corners, which inline text cannot take in nsh; spaces to
                        fake the padding would end up in the sentence ("9 AM , run"). */}
                    <Text class={`font-semibold ${previewError() ? "bg-danger/9 text-danger" : "bg-blue/9 text-blue"}`}>
                      {part().text}
                    </Text>
                  </If>
                )}
              </Each>
            </Text>
          </View>

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
            <FieldNote>{t("todo_workspace_dir_hint")}</FieldNote>
          </View>

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
            <BaseButton
              onPress={() => state.edits.addBashEnvRow(task())}
              disabled={busy()}
              accessibilityLabel={t("todo_bash_env_add")}
              testID="todo-bash-env-add"
              class="h-9.5 flex-row items-center justify-center gap-2 rounded-(--radius) border border-dashed border-blue/35 bg-white/45 hover:border-blue/60 hover:bg-white/75 disabled:opacity-50"
              style={{ transitionProperty: "colors", transitionDuration: 180 }}
            >
              <Icon name="PhPlus" size={16} color="subtle" />
              <Text class="text-sm font-medium tracking-[0.14px] text-subtle">{t("todo_bash_env_add")}</Text>
            </BaseButton>
          </View>
        </View>
      </View>
    </TodoCard>
  );
}
