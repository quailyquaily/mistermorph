// The subagents and coders a task started, below its status card: each a chip with its avatar,
// name and state. A chip opens the worker in the temporary detail panel beside the conversation
// (pages/chat/ActivityDetailPanel.tsx), which shows its PIDs and output (`ChatWorkerOutput`), not
// inside the conversation. Which worker is open is the page's state (activityDetail.ts), since
// rows recycle. Ported from web/console/src/components/ChatWorkerRoster.js.
import type { ViewRef } from "nsh";
import { effect, Image, Text, View } from "nsh";
import { Tip, TipButton } from "../ui";
import { localeState } from "../../lib/core/context.js";
import { rosterWorkers, workerProcessLabel } from "../../lib/core/chat-workers.js";
import { workerAvatarURL } from "../../lib/core/worker-avatars.js";
import { t } from "./i18n";
import { OverflowLine } from "./OverflowLine";

function stateTone(state: string) {
  switch (state) {
    case "done":
      return "bg-status-on border-status-on";
    case "failed":
    case "canceled":
      return "bg-status-error border-status-error";
    default:
      return "bg-status-pending border-status-pending";
  }
}

export function WorkerAvatar(props: { avatarStyle: string }) {
  return <Image src={workerAvatarURL(props.avatarStyle)} accessibilityElementsHidden style={{ width: 20, height: 20 }} />;
}

export function workerKindLabel(worker: any) {
  return worker?.kind === "coder" ? t("chat_worker_kind_coder") : t("chat_worker_kind_subagent");
}

export function workerStateLabel(state: string) {
  return t(`chat_worker_state_${state}`);
}

/** The workers of a reply as the roster shows them (named in the Console's language). */
export function replyWorkers(activity: any, status: string): any[] {
  return rosterWorkers(activity, status, localeState.lang);
}

/** A chip of the roster; `focus` hands it the keyboard focus back as its panel closes. */
function WorkerChip(props: { worker: any; selected: boolean; focus: boolean; onPress: () => void }) {
  let node: ViewRef | undefined;
  effect(() => {
    if (props.focus) node?.focus();
  });
  const label = () => `${props.worker.displayName} · ${workerKindLabel(props.worker)} · ${workerStateLabel(props.worker.state)}`;
  return (
    <TipButton
      ref={(ref: ViewRef) => (node = ref)}
      selected={props.selected}
      onPress={props.onPress}
      accessibilityLabel={label()}
      tooltip={<Tip text={label()} />}
      testID="chat-worker-chip"
      class="flex-row items-center gap-1.5 rounded-full border border-line-faint bg-card py-0.5 pl-0.5 pr-2 hover:bg-hover selected:border-blue selected:bg-selection"
    >
      <WorkerAvatar avatarStyle={props.worker.avatarStyle} />
      <Text class="text-xs text-foreground">{props.worker.displayName}</Text>
      <View class={`size-1.5 rounded-full border ${stateTone(props.worker.state)}`} />
    </TipButton>
  );
}

export function ChatWorkerRoster(props: {
  itemID: string;
  activity: any;
  status: string;
  /** The worker of this reply the detail panel shows ("" for none). */
  selectedID: string;
  /** The worker whose chip takes the focus back now (its panel just closed). */
  focusID?: string;
  onSelect: (workerID: string) => void;
}) {
  const workers = (): any[] => replyWorkers(props.activity, props.status);
  const omitted = () => Math.max(0, Number(props.activity?.workersOmitted) || 0);

  return (
    <If when={workers().length > 0}>
      <View class="flex-row flex-wrap items-center gap-1.5" accessibilityLabel={t("chat_workers_title")} testID="chat-worker-roster">
        <Each of={workers()} key={(worker) => `${props.itemID}:worker:${worker.id}`}>
          {(worker) => (
            <WorkerChip
              worker={worker()}
              selected={worker().id === props.selectedID}
              focus={Boolean(props.focusID) && worker().id === props.focusID}
              onPress={() => props.onSelect(worker().id)}
            />
          )}
        </Each>
        <If when={omitted() > 0}>
          <Text class="text-xs text-muted-foreground">{t("chat_workers_omitted", { count: omitted() })}</Text>
        </If>
      </View>
    </If>
  );
}

/** A worker as the detail panel shows it: its kind, state and processes, then its output by
 *  section (the panel scrolls it and follows its end). */
export function ChatWorkerOutput(props: { worker: any }) {
  const worker = () => props.worker;
  return (
    <View class="gap-3" testID="chat-worker-output">
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="text-xs text-muted-foreground">{workerKindLabel(worker())}</Text>
        <Text class="font-mono text-xs uppercase text-subtle">{workerStateLabel(worker().state)}</Text>
        <Each
          of={Array.isArray(worker().processes) ? worker().processes : []}
          key={(process: any) => `${process.pid}:${process.program}:${process.activityId}`}
        >
          {(process) => (
            <OverflowLine testID="chat-worker-process">
              <Text class="font-mono text-xs text-muted-foreground">{workerProcessLabel(process())}</Text>
            </OverflowLine>
          )}
        </Each>
      </View>
      <If when={worker().sections.length > 0} else={<Text class="text-xs text-muted-foreground">{t("chat_worker_no_output")}</Text>}>
        <View class="gap-3">
          <Each of={worker().sections as any[]} key={(section) => section.kind}>
            {(section) => (
              <View class="gap-1">
                <If when={worker().sections.length > 1}>
                  <Text class="font-mono text-xs uppercase text-muted-foreground">{t(`chat_worker_section_${section().kind}`)}</Text>
                </If>
                <View selectable>
                  <Text class={`font-mono text-xs ${section().kind === "error" ? "text-danger" : "text-foreground"}`}>{section().text}</Text>
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
