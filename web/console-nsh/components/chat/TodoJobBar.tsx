// A TODO topic's toolbar, at the foot of the conversation where a person's topic has its composer:
// the bottom navigation's glass capsule (GlassCapsule), centred, with two buttons. The first starts
// one run of the item now, and reads Stop while the runtime runs it (it stops that run, not the
// schedule); View Job opens the item on the TODO page. A failure and a gone item are said above the
// capsule, never inside it, and the capsule always holds the same two buttons (disabled while they
// cannot act). The state is the chat's (components/chat/todoJob.ts); the props here are plain values
// so the gallery can show each state.
import { Text, View } from "nsh";
import { Button } from "../ui";
import { BAR_BELOW, BAR_INSET, GlassCapsule, MOBILE_NAV_HEIGHT } from "../frame/mobileBar";
import { t } from "./i18n";

export interface TodoJobBarProps {
  /** The runtime runs the item now: the first button reads Stop. */
  running: boolean;
  /** Start or Stop is on its way (or the run is winding down): the first button is busy. */
  busy?: boolean;
  /** The first button can act now (Start on an idle item, Stop on a running one). */
  toggleEnabled: boolean;
  /** View Job can open the item. */
  viewEnabled: boolean;
  /** A quiet line above the capsule (the item is gone). */
  note?: string;
  /** What failed, above the capsule, read out as it appears. */
  error?: string;
  onStart?: () => void;
  onStop?: () => void;
  onView?: () => void;
}

export function TodoJobBar(props: TodoJobBarProps) {
  return (
    // The capsule sits as far above the foot as the navigation's does, and is as tall.
    <View class="w-full items-center gap-2 pt-2" style={{ pointerEvents: "box-none", paddingBottom: BAR_BELOW }} testID="chat-todo-job">
      <If when={props.error}>
        <Text role="alert" class="max-w-full px-2 text-center text-sm text-danger" testID="chat-todo-job-error">
          {props.error}
        </Text>
      </If>
      <If when={props.note}>
        <Text class="max-w-full px-2 text-center text-sm text-muted-foreground" testID="chat-todo-job-note">
          {props.note}
        </Text>
      </If>
      <GlassCapsule testID="chat-todo-job-bar" role="toolbar" accessibilityLabel={t("chat_todo_job_toolbar")}>
        <View class="flex-row items-center gap-1" style={{ height: MOBILE_NAV_HEIGHT - BAR_INSET * 2 }}>
          <Button
            variant={props.running ? "ghost-danger" : "plain"}
            size="md"
            // The console's Button draws no focus mark: a keyboard focus here shows as its hover fill.
            class={`min-w-24 rounded-full ${props.running ? "focus:bg-close" : "focus:bg-hover"}`}
            label={props.running ? t("chat_todo_job_stop") : t("chat_todo_job_start")}
            loading={props.busy}
            disabled={!props.toggleEnabled}
            onPress={() => (props.running ? props.onStop?.() : props.onStart?.())}
            testID="chat-todo-job-toggle"
          />
          <Button
            variant="plain"
            size="md"
            class="min-w-24 rounded-full focus:bg-hover"
            label={t("chat_todo_job_view")}
            disabled={!props.viewEnabled}
            onPress={() => props.onView?.()}
            testID="chat-todo-job-view"
          />
        </View>
      </GlassCapsule>
    </View>
  );
}
