// The Heartbeat editor: a boxed card whose head is the mono "HEARTBEAT" label, the note on one line
// and a plain Save; under it the heartbeat's workflows, one card each, in the order a tick runs
// them. A workflow has a title, a switch (an off workflow is kept but not run) and its
// instructions in a Markdown editor; it can move up or down and be deleted. "Add workflow" adds
// one at the end. Save replaces the list (PUT /heartbeat/workflows).
import { Scroll, Text, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { SCROLLBAR } from "../motion";
import { AppMarkdownEditor } from "../shared/MarkdownEditor";
import { Button, Icon, ProgressBar, Toggle } from "../ui";
import { TodoCard } from "./TodoCard";
import { TodoInput } from "./TodoFields";
import type { HeartbeatWorkflow, TodoState } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

function WorkflowCard(props: { state: TodoState; item: () => HeartbeatWorkflow; index: () => number; count: () => number }) {
  const state = props.state;
  const locked = () => state.heartbeatLoading() || state.heartbeatSaving();
  const key = () => props.item()._key;
  return (
    <View
      class={`gap-2 rounded-(--radius) border border-line-soft bg-card p-3 ${props.item().enabled ? "" : "opacity-60"}`}
      testID={`todo-heartbeat-workflow-${props.index()}`}
    >
      <View class="flex-row items-center gap-2">
        <TodoInput
          value={props.item().title}
          onChange={(value) => state.updateHeartbeatWorkflow(key(), { title: value })}
          placeholder={t("todo_heartbeat_workflow_title_placeholder")}
          accessibilityLabel={t("todo_heartbeat_workflow_title")}
          disabled={locked()}
          strong
          testID={`todo-heartbeat-workflow-title-${props.index()}`}
          class="flex-1"
        />
        <Toggle
          checked={props.item().enabled}
          label={t("todo_heartbeat_workflow_enabled")}
          hideLabel
          disabled={locked()}
          testID={`todo-heartbeat-workflow-enabled-${props.index()}`}
          onChange={(checked) => state.updateHeartbeatWorkflow(key(), { enabled: checked })}
        />
        <Button
          variant="plain"
          size="xs"
          icon="PhCaretUp"
          iconOnly
          title={t("todo_heartbeat_workflow_move_up")}
          disabled={locked() || props.index() === 0}
          testID={`todo-heartbeat-workflow-up-${props.index()}`}
          onPress={() => state.moveHeartbeatWorkflow(key(), -1)}
        />
        <Button
          variant="plain"
          size="xs"
          icon="PhCaretDown"
          iconOnly
          title={t("todo_heartbeat_workflow_move_down")}
          disabled={locked() || props.index() >= props.count() - 1}
          testID={`todo-heartbeat-workflow-down-${props.index()}`}
          onPress={() => state.moveHeartbeatWorkflow(key(), 1)}
        />
        <Button
          variant="plain"
          size="xs"
          icon="PhTrash"
          iconOnly
          title={t("todo_heartbeat_workflow_delete")}
          disabled={locked()}
          testID={`todo-heartbeat-workflow-delete-${props.index()}`}
          onPress={() => state.removeHeartbeatWorkflow(key())}
        />
      </View>
      <AppMarkdownEditor
        value={props.item().instructions}
        height={180}
        disabled={locked()}
        placeholder={t("todo_heartbeat_placeholder")}
        accessibilityLabel={t("todo_heartbeat_workflow_instructions")}
        testID={`todo-heartbeat-workflow-instructions-${props.index()}`}
        class="min-h-45"
        onChange={(value) => state.updateHeartbeatWorkflow(key(), { instructions: value })}
      />
    </View>
  );
}

export function TodoHeartbeatEditor(props: { state: TodoState }) {
  const state = props.state;
  const items = () => state.heartbeatWorkflows();
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
      <Scroll class="flex-1" scrollbar={SCROLLBAR}>
        <View class="gap-2" testID="todo-heartbeat-workflows">
          <If when={!state.heartbeatLoading() && items().length === 0}>
            <Text class="text-sm text-muted-foreground" testID="todo-heartbeat-empty">
              {t("todo_heartbeat_workflows_empty")}
            </Text>
          </If>
          <Each of={items()} key={(item) => item._key}>
            {(item, index) => <WorkflowCard state={state} item={item} index={index} count={() => items().length} />}
          </Each>
          <Button
            variant="outlined"
            size="xs"
            icon="PhPlus"
            label={t("todo_heartbeat_workflow_add")}
            disabled={state.heartbeatLoading() || state.heartbeatSaving()}
            testID="todo-heartbeat-add"
            onPress={() => state.addHeartbeatWorkflow()}
          />
        </View>
      </Scroll>
    </TodoCard>
  );
}
