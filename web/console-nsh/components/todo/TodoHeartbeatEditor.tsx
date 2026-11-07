// The Heartbeat editor (the Vue page's heartbeat editor card, views/TodoView.css
// `.todo-heartbeat-editor-*`): a boxed card whose head is the mono "HEARTBEAT" label, the note on
// one line and a plain Save; HEARTBEAT.md in a Markdown editor that fills the rest of the card.
import { Text, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { AppMarkdownEditor } from "../shared/MarkdownEditor";
import { Button, Icon, ProgressBar } from "../ui";
import { TodoCard } from "./TodoCard";
import type { TodoState } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export function TodoHeartbeatEditor(props: { state: TodoState }) {
  const state = props.state;
  return (
    <TodoCard
      title={t("todo_heartbeat_title")}
      meta={t("todo_heartbeat_editor_meta")}
      fill
      bodyClass="gap-2"
      testID="todo-heartbeat-editor"
      actions={
        <Button
          variant="plain"
          size="xs"
          label={t("action_save")}
          disabled={!state.canSave()}
          loading={state.heartbeatSaving()}
          testID="todo-heartbeat-save"
          onPress={() => void state.save()}
        />
      }
    >
      <If when={state.heartbeatLoading()}>
        <ProgressBar indeterminate label={t("todo_heartbeat_loading")} />
      </If>
      <If when={state.heartbeatDisabled()}>
        <View class="flex-row items-center gap-2 rounded-(--radius) border-l-2 border-warn bg-paper px-3 py-2" role="alert">
          <Icon name="PhWarning" size={15} color="warn-dark" />
          <Text class="flex-1 text-sm text-foreground">{t("todo_heartbeat_disabled_hint")}</Text>
        </View>
      </If>
      <AppMarkdownEditor
        value={state.heartbeatContent()}
        height="100%"
        disabled={state.heartbeatLoading() || state.heartbeatSaving()}
        placeholder={t("todo_heartbeat_placeholder")}
        accessibilityLabel={t("todo_heartbeat_title")}
        testID="todo-heartbeat-content"
        class="min-h-80 flex-1"
        onChange={(value) => state.onHeartbeatContentChange(value)}
      />
    </TodoCard>
  );
}
