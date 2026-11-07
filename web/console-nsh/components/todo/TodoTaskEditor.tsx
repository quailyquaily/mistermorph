// The editor of one TODO item (the task editor card of web/console/src/views/TodoView.js): the
// enabled switch, Save and the action menu in its head, then the title, the content, the
// timezone / schedule / model / chat pickers, the date or the repeat, the preview sentence, the
// workspace directory and the bash environment.
import { Text, View } from "nsh";
import { DatePicker, TimeField } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { AppMarkdownEditor } from "../shared/MarkdownEditor";
import { Button, DropdownMenu, Icon, type MenuEntry, Spinner, Tabs, TextField, Toggle } from "../ui";
import * as model from "./todo-model.js";
import { TodoSelect } from "./TodoSelect";
import type { TodoState, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

function Prepend(props: { children: string }) {
  return <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.children}</Text>;
}

function FieldNote(props: { children: string }) {
  return <Text class="text-xs text-muted-foreground">{props.children}</Text>;
}

/**
 * A field whose shown value the model may normalize: rebuilt when the page asks (repeatInputRevision),
 * so a typed value the model changed (75 minutes, day 0) shows the normalized one. The Vue view also
 * keyed it by the value; here the controlled value follows by itself, and the field keeps its focus.
 */
function NormalizedField(props: {
  revisionKey: string;
  value: string;
  label: string;
  disabled?: boolean;
  testID?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Each of={[props.revisionKey]}>
      {() => (
        <TextField
          value={props.value}
          onChange={(value) => props.onChange(value)}
          keyboardType="number-pad"
          accessibilityLabel={props.label}
          disabled={props.disabled}
          testID={props.testID}
          class="flex-1"
          inputClass="font-mono"
        />
      )}
    </Each>
  );
}

export function TodoTaskEditor(props: { state: TodoState }) {
  const state = props.state;
  const task = () => state.selectedTask() as TodoTask;
  const busy = () => state.saving() || state.loading();
  const kind = () => model.repeatKind(task()) as string;

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

  return (
    <View class="gap-4" accessibilityLabel={t("todo_detail_title")} testID="todo-task-editor">
      <View class="flex-row items-center gap-2">
        <Toggle
          checked={task().enabled !== false}
          disabled={busy()}
          label={t("todo_field_enabled")}
          testID="todo-enabled"
          onChange={(checked) => state.edits.enabled(task(), checked)}
          class="flex-1"
        />
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
            <View
              testID="todo-task-actions"
              accessibilityLabel={t("todo_action_more")}
              role="button"
              class={`size-7 items-center justify-center rounded-(--radius) hover:bg-hover ${busy() ? "opacity-45" : ""}`}
            >
              <If when={state.runningTaskKey() === task()._key} else={<Icon name="PhDotsThree" size={18} color="subtle" />}>
                <Spinner size={14} />
              </If>
            </View>
          }
        />
      </View>

      <TextField
        value={task().title}
        placeholder={t("todo_untitled")}
        accessibilityLabel={t("todo_field_title")}
        disabled={busy()}
        testID="todo-title"
        inputClass="text-lg font-semibold"
        onChange={(value) => state.edits.title(task(), value)}
      />

      <AppMarkdownEditor
        value={task().content}
        height="clamp(168px, 26vh, 320px)"
        placeholder={t("todo_content_placeholder")}
        accessibilityLabel={t("todo_field_content")}
        disabled={busy()}
        testID="todo-content"
        onChange={(value) => state.edits.field(task(), "content", value)}
      />

      <View class="flex-row flex-wrap gap-2">
        <TodoSelect
          class="min-w-56 flex-1"
          label={t("todo_field_timezone")}
          items={model.timezoneBaseItems()}
          current={model.timezoneItem(task())}
          placeholder={t("todo_timezone_placeholder")}
          searchable
          disabled={busy()}
          testID="todo-timezone"
          onChange={(value) => state.edits.timezone(task(), value)}
        />
        <TodoSelect
          class="min-w-56 flex-1"
          label={t("todo_field_schedule")}
          items={model.scheduleModeItems()}
          current={model.scheduleModeItems().find((item: { value: string }) => item.value === model.taskMode(task()))}
          placeholder={t("todo_field_schedule")}
          disabled={busy()}
          testID="todo-schedule-mode"
          onChange={(value) => state.edits.scheduleMode(task(), value)}
        />
        <TodoSelect
          class="min-w-56 flex-1"
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
        <TodoSelect
          class="min-w-56 flex-1"
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

      <If
        when={model.taskMode(task()) === "once"}
        else={
          <View class="gap-3">
            <Tabs
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
                <View class="gap-1">
                  <TextField
                    value={task().custom_cron}
                    placeholder={t("todo_custom_cron_placeholder")}
                    accessibilityLabel={t("todo_field_cron")}
                    disabled={busy()}
                    mono
                    testID="todo-custom-cron"
                    onChange={(value) => state.edits.customCron(task(), value)}
                  />
                  <FieldNote>{t("todo_custom_cron_note")}</FieldNote>
                </View>
              }
            >
              <View class="flex-row flex-wrap items-center gap-3">
                <If
                  when={kind() === "hourly"}
                  else={
                    <View class="flex-row items-center gap-2">
                      <Prepend>{t("todo_field_time")}</Prepend>
                      <TimeField
                        value={task().repeat_time || "09:00"}
                        disabled={busy()}
                        accessibilityLabel={t("todo_field_time")}
                        testID="todo-repeat-time"
                        onChange={({ value }) => state.edits.repeatTime(task(), value)}
                        class="h-8 flex-row items-center rounded-(--radius) border border-input bg-field px-2 disabled:opacity-50"
                        segmentClass="rounded-(--radius) px-0.5 text-sm text-foreground focus:bg-selection"
                        separatorClass="text-sm text-muted-foreground"
                      />
                    </View>
                  }
                >
                  <View class="w-40 flex-row items-center gap-2">
                    <Prepend>{t("todo_field_minute")}</Prepend>
                    <NormalizedField
                      revisionKey={`minute-${task()._key}-${state.repeatInputRevision()}`}
                      value={model.repeatMinuteValue(task()) as string}
                      label={t("todo_field_minute")}
                      disabled={busy()}
                      testID="todo-repeat-minute"
                      onChange={(value) => state.edits.repeatMinute(task(), value)}
                    />
                  </View>
                </If>

                <If when={kind() === "weekly"}>
                  <View class="flex-row flex-wrap gap-1" accessibilityLabel={t("todo_field_weekdays")} role="group">
                    <Each of={model.WEEKDAYS as { value: number; labelKey: string }[]} key={(day) => day.value}>
                      {(day) => (
                        <Button
                          variant={model.weekdaySelected(task(), day().value) ? "primary" : "outlined"}
                          size="xs"
                          label={model.weekdayLabel(day().value) as string}
                          selected={Boolean(model.weekdaySelected(task(), day().value))}
                          disabled={busy()}
                          testID={`todo-weekday-${day().value}`}
                          onPress={() => state.edits.toggleWeekday(task(), day().value)}
                        />
                      )}
                    </Each>
                  </View>
                </If>

                <If when={kind() === "monthly"}>
                  <View class="w-40 flex-row items-center gap-2">
                    <Prepend>{t("todo_field_day")}</Prepend>
                    <NormalizedField
                      revisionKey={`month-day-${task()._key}-${state.repeatInputRevision()}`}
                      value={task().repeat_month_day}
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
        <View class="flex-row items-center gap-2">
          <Prepend>{t("todo_field_at")}</Prepend>
          <DatePicker
            value={model.atInputValue(task()) || null}
            timePrecision="minute"
            disabled={busy()}
            accessibilityLabel={t("todo_field_at")}
            timeAccessibilityLabel={t("todo_field_time")}
            testID="todo-at"
            onChange={({ value }) => {
              if (typeof value === "string") state.edits.at(task(), value);
            }}
            offset={4}
            popupClass="rounded-(--radius) border border-border bg-popover p-3 shadow-md"
            backdropClass="bg-scrim"
            headerClass="flex-row items-center justify-between pb-2"
            rowClass="flex-row justify-between"
            itemClass="h-8 min-w-8 items-center justify-center rounded-(--radius) text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
            timeClass="mt-2 flex-row items-center justify-between gap-3"
            timeLabel={<Text class="text-sm text-subtle">{t("todo_field_time")}</Text>}
            timeFieldClass="flex-row items-center rounded-(--radius) border border-input px-2 py-1"
            segmentClass="rounded-(--radius) px-0.5 text-sm text-foreground focus:bg-selection"
            separatorClass="text-sm text-muted-foreground"
            trigger={
              <View class="h-8 min-w-48 flex-row items-center gap-2 rounded-(--radius) border border-input bg-field px-2.5 hover:border-ring">
                <Icon name="PhCalendarBlank" size={14} color="muted-foreground" />
                <Text class="font-mono text-sm text-foreground">{String(task().at || "").replace("T", " ")}</Text>
              </View>
            }
          />
        </View>
      </If>

      <View
        class={`gap-1 rounded-(--radius) border px-3 py-2 ${previewError() ? "border-danger" : "border-line-faint bg-paper"}`}
        testID="todo-preview"
      >
        <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t("todo_repeat_preview")}</Text>
        <Text class="text-sm text-foreground">
          <Each of={previewSegments()}>
            {(part) => (
              <Text
                class={
                  part().type === "mark"
                    ? previewError()
                      ? "font-semibold text-danger"
                      : "font-semibold text-blue-dark"
                    : "text-subtle"
                }
              >
                {part().text}
              </Text>
            )}
          </Each>
        </Text>
      </View>

      <View class="gap-1">
        <TextField
          value={task().workspace_dir}
          placeholder={t("todo_workspace_dir_placeholder")}
          accessibilityLabel={t("todo_field_workspace_dir")}
          label={t("todo_field_workspace_dir")}
          disabled={busy()}
          mono
          testID="todo-workspace-dir"
          onChange={(value) => state.edits.workspaceDir(task(), value)}
          trailing={
            <View class="flex-row items-center">
              <If when={task().workspace_dir}>
                <Button
                  variant="plain"
                  size="xs"
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
                size="xs"
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

      <View class="gap-2">
        <View class="gap-0.5">
          <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t("todo_field_bash_env")}</Text>
          <FieldNote>{t("todo_bash_env_hint")}</FieldNote>
        </View>
        <If when={model.hasBashEnvRows(task())}>
          <View class="gap-2">
            <Each of={task().bash_env.map((_, index) => index)}>
              {(index) => (
                <View class="flex-row items-center gap-2">
                  <TextField
                    class="flex-1"
                    value={task().bash_env[index()]?.name ?? ""}
                    placeholder={t("todo_bash_env_name")}
                    accessibilityLabel={t("todo_bash_env_name")}
                    disabled={busy()}
                    mono
                    testID={`todo-bash-env-name-${index()}`}
                    onChange={(value) => state.edits.bashEnvField(task(), index(), "name", value)}
                  />
                  <TextField
                    class="flex-[2]"
                    value={task().bash_env[index()]?.value ?? ""}
                    placeholder={t("todo_bash_env_value")}
                    accessibilityLabel={t("todo_bash_env_value")}
                    disabled={busy()}
                    mono
                    testID={`todo-bash-env-value-${index()}`}
                    onChange={(value) => state.edits.bashEnvField(task(), index(), "value", value)}
                  />
                  <Button
                    variant="plain"
                    size="sm"
                    iconOnly
                    icon="PhTrash"
                    title={t("action_delete")}
                    disabled={busy()}
                    testID={`todo-bash-env-remove-${index()}`}
                    onPress={() => state.edits.removeBashEnvRow(task(), index())}
                  />
                </View>
              )}
            </Each>
          </View>
        </If>
        <Button
          variant="outlined"
          size="sm"
          icon="PhPlus"
          label={t("todo_bash_env_add")}
          disabled={busy()}
          testID="todo-bash-env-add"
          onPress={() => state.edits.addBashEnvRow(task())}
        />
      </View>
    </View>
  );
}
