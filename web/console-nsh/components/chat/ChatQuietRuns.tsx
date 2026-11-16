// A TODO item's runs that found nothing to do, folded (lib/core/chat-quiet-runs.js): one centred
// line with a hollow mark, how many runs it stands for and their time span. Pressed, it opens:
// one row per run under it, its time and its reply cut to one line, on the faint rule the Agent
// Link exchange hangs its messages on; the task's message is not repeated, since it is the same
// every run. Pressing a row shows that run in full under it, as it would look unfolded.
//
// It is part of a List row, so what is open is the page's state (ChatRowContext.folds), by the
// group's id and by each run's task id.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { quietGroupFoldKey, quietRunFoldKey, quietRunsSpan } from "../../lib/core/chat-quiet-runs.js";
import { Icon } from "../ui";
import { ChatNoticeLine } from "./ChatNoticeLine";
import { t } from "./i18n";
import type { KeyedState } from "./rowState";

type Item = Record<string, any>;

export interface QuietRun {
  id: string;
  at: string;
  text: string;
  user: Item | null;
  agent: Item;
}

/** "8 runs, nothing to do", in the Console's language. */
export function quietRunsCountText(count: number) {
  return t(count === 1 ? "chat_quiet_runs_one" : "chat_quiet_runs_many", { count });
}

export function ChatQuietRuns(props: {
  /** The group row foldQuietRuns made. */
  group: Item;
  folds: KeyedState<boolean>;
  /** Draws one message of a run shown in full (the conversation's own row). */
  renderMessage: (item: () => Item) => JSX.Element;
}) {
  const runs = (): QuietRun[] => (Array.isArray(props.group?.runs) ? props.group.runs : []);
  const groupKey = () => quietGroupFoldKey(props.group?.id);
  const open = () => props.folds.get(groupKey()) === true;
  const full = (run: QuietRun) => props.folds.get(quietRunFoldKey(run.id)) === true;
  return (
    <View class="gap-2" testID="chat-quiet-runs">
      <ChatNoticeLine
        state="off"
        text={quietRunsCountText(runs().length)}
        detail={quietRunsSpan(props.group)}
        open={open()}
        onPress={() => props.folds.set(groupKey(), !open())}
        testID="chat-quiet-runs-line"
      />
      <If when={open()}>
        <View class="ml-1 gap-1.5 self-stretch border-l border-line-faint pl-3" testID="chat-quiet-runs-list">
          <Each of={runs()} key={(run) => run.id}>
            {(run) => (
              <View class="gap-2">
                <BaseButton
                  onPress={() => props.folds.set(quietRunFoldKey(run().id), !full(run()))}
                  selected={full(run())}
                  accessibilityLabel={[run().at, run().text].filter(Boolean).join(" ")}
                  class="-ml-1.5 flex-row items-center gap-3 rounded-(--radius) px-1.5 py-0.5 hover:bg-hover focus:bg-hover"
                  testID="chat-quiet-run"
                >
                  <Text class="min-w-10 font-mono text-[11px] leading-5 tracking-[0.04em] text-muted-foreground" testID="chat-quiet-run-time">
                    {run().at}
                  </Text>
                  {/* Shown in full under the row, the reply is not said twice. */}
                  <Text class="min-w-0 flex-1 text-sm leading-5 text-subtle line-clamp-1" testID="chat-quiet-run-text">
                    {full(run()) ? "" : run().text}
                  </Text>
                  <Icon name={full(run()) ? "PhCaretUp" : "PhCaretDown"} size={11} color="muted-foreground" />
                </BaseButton>
                <If when={full(run())}>
                  <View class="gap-5 pb-3 pt-1" testID="chat-quiet-run-full">
                    <If when={run().user}>{props.renderMessage(() => run().user as Item)}</If>
                    {props.renderMessage(() => run().agent)}
                  </View>
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
