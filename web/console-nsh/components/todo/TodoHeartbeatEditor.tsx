// The Heartbeat editor (the Vue page's heartbeat editor card): HEARTBEAT.md in a Markdown editor,
// saved with its own Save.
import { View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { AppMarkdownEditor } from "../shared/MarkdownEditor";
import { Button, Icon, ProgressBar, Section } from "../ui";
import { Text } from "nsh";
import type { TodoState } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export function TodoHeartbeatEditor(props: { state: TodoState }) {
  const state = props.state;
  return (
    <Section
      variant="card"
      title={t("todo_heartbeat_title")}
      meta={t("todo_heartbeat_editor_meta")}
      class="flex-1"
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
        height="clamp(320px, 60vh, 760px)"
        disabled={state.heartbeatLoading() || state.heartbeatSaving()}
        placeholder={t("todo_heartbeat_placeholder")}
        accessibilityLabel={t("todo_heartbeat_title")}
        testID="todo-heartbeat-content"
        class="flex-1"
        onChange={(value) => state.onHeartbeatContentChange(value)}
      />
    </Section>
  );
}
