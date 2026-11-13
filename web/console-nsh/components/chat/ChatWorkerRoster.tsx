// The subagents and coders a task started, below its status card: each a chip with its avatar,
// name and state. A chip opens the worker in the temporary detail panel beside the conversation
// (pages/chat/ActivityDetailPanel.tsx), which shows its PIDs and output (`ChatWorkerOutput`) on
// the same dark terminal as the reply's progress, not inside the conversation. Which worker is open
// is the page's state (activityDetail.ts), since rows recycle. Ported from web/console/src/components/ChatWorkerRoster.js.
import type { ViewRef } from "nsh";
import { effect, Image, Text, View } from "nsh";

/** How the agent started a worker (lib/core/chat-workers.js `workerAsk`). */
export interface WorkerAsk {
  task: string;
  settings: { key: string; value: string }[];
  at: string;
  calls: any[];
  callsOmitted: number;
}
import { Tip, TipButton } from "../ui";
import { localeState } from "../../lib/core/context.js";
import { rosterWorkers, workerProcessLabel } from "../../lib/core/chat-workers.js";
import { ActivityCallTree, ParamRow } from "./ChatStatusCard";
import { workerAvatarURL } from "../../lib/core/worker-avatars.js";
import { t } from "./i18n";
import { TERMINAL_FG, TERMINAL_LABEL, TERMINAL_MUTED, terminalNoteClass } from "./ChatTerminal";
import { OverflowLine } from "./OverflowLine";
import { KindChip, NEON, StatusTag, TerminalText } from "./TerminalText";

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

/** A worker as the detail panel shows it, on the panel's terminal (ChatTerminal) as its progress
 *  is: its kind, state and processes, then its output by section (the panel scrolls it and follows
 *  its end). */
/**
 * A speaker line of the worker's conversation, `MORPH > CURIE`, the time at its end: plain mono
 * ASCII, so it lines up as the rest of the readout does.
 */
function Speaker(props: { from: string; to: string; fromColor: string; toColor: string; at?: string; testID?: string }) {
  return (
    <View class="flex-row items-center gap-2" testID={props.testID}>
      {/* Upper-cased here, not with the `uppercase` style: the text is measured as written. */}
      <Text class="font-mono text-[11px] leading-[18px]">
        <Text style={{ color: props.fromColor }}>{props.from.toLocaleUpperCase()}</Text>
        <Text style={{ color: NEON.idle }}>{" > "}</Text>
        <Text style={{ color: props.toColor }}>{props.to.toLocaleUpperCase()}</Text>
      </Text>
      <View class="flex-1" />
      <If when={props.at}>
        <Text class="font-mono text-[11px]" style={{ color: NEON.idle }}>
          {props.at}
        </Text>
      </If>
    </View>
  );
}

function clock(raw: string) {
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * A subagent's or coder's run as the conversation it is (a readout on the terminal, TerminalText):
 * its state, kind and processes; then what the agent asked it (`ask`: the task, whole, and the
 * settings of the call) and the calls it made on its own; then what it printed and what it answered
 * (its result, or its error). While it runs, its answer is the running state.
 */
export function ChatWorkerOutput(props: { worker: any; ask?: WorkerAsk | null; agentName?: string; itemID?: string }) {
  const worker = () => props.worker;
  const agent = () => props.agentName || t("chat_worker_agent");
  const name = () => String(worker().displayName || worker().name || "");
  const tone = () => (worker().kind === "coder" ? NEON.cyan : NEON.violet);
  const sections = (): any[] => (Array.isArray(worker().sections) ? worker().sections : []);
  // What it printed while it ran, then what it answered (its result, an error or a summary).
  const printed = () => sections().filter((section) => section.kind === "output");
  const answer = () => sections().filter((section) => section.kind !== "output");
  const running = () => worker().state === "running";
  return (
    <View class="gap-3" testID="chat-worker-output">
      {/* A readout's head (TerminalText.tsx): its state tag, its kind as a chip, its processes. */}
      <View class="flex-row flex-wrap items-center gap-2">
        <StatusTag status={String(worker().state || "")} testID="chat-worker-status" />
        <KindChip label={workerKindLabel(worker())} tone={worker().kind === "coder" ? "cyan" : "violet"} />
        <Each
          of={Array.isArray(worker().processes) ? worker().processes : []}
          key={(process: any) => `${process.pid}:${process.program}:${process.activityId}`}
        >
          {(process) => (
            <OverflowLine testID="chat-worker-process">
              <TerminalText text={workerProcessLabel(process())} class={`font-mono text-[11px] leading-[18px] ${TERMINAL_MUTED}`} />
            </OverflowLine>
          )}
        </Each>
      </View>

      {/* What the agent asked: the task as it was sent, the call's settings under it. */}
      <If when={props.ask?.task || props.ask?.settings.length}>
        <View class="gap-1.5" testID="chat-worker-ask">
          <Speaker from={agent()} to={name()} fromColor={NEON.ok} toColor={tone()} at={clock(props.ask?.at ?? "")} />
          <If when={props.ask?.task}>
            <View selectable class="border-l-2 pl-2.5" style={{ borderColor: `${NEON.ok}80` }}>
              <TerminalText text={props.ask?.task ?? ""} copyOnly class={`font-mono text-xs leading-[18px] ${TERMINAL_FG}`} testID="chat-worker-task" />
            </View>
          </If>
          <Each of={props.ask?.settings ?? []} key={(setting) => setting.key}>
            {(setting) => <ParamRow name={setting().key} value={setting().value} limit={0} class="pl-3" testID="chat-worker-setting" />}
          </Each>
        </View>
      </If>

      {/* What it did on its own: a subagent's calls. */}
      <If when={(props.ask?.calls.length ?? 0) > 0 || (props.ask?.callsOmitted ?? 0) > 0}>
        <View class="gap-1 pl-3" testID="chat-worker-calls">
          <ActivityCallTree itemID={`${props.itemID ?? ""}:${worker().id}`} calls={props.ask?.calls ?? []} omitted={props.ask?.callsOmitted} />
        </View>
      </If>

      {/* What it printed while it ran (a coder's terminal). */}
      <Each of={printed()} key={(section) => section.kind}>
        {(section) => (
          <View class="gap-1">
            <Text class={TERMINAL_LABEL}>{t(`chat_worker_section_${section().kind}`)}</Text>
            <View selectable class="border-l-2 pl-2.5" style={{ borderColor: "#ffffff1f" }}>
              <TerminalText text={section().text} copyOnly class={`font-mono leading-[18px] ${terminalNoteClass(false)}`} />
            </View>
          </View>
        )}
      </Each>

      {/* What it answered: its result, or its error; while it runs, that it is running. */}
      <View class="gap-1.5" testID="chat-worker-answer">
        <Speaker from={name()} to={agent()} fromColor={tone()} toColor={NEON.ok} />
        <If
          when={answer().length > 0}
          else={
            <Text class={`pl-3 font-mono text-xs ${TERMINAL_MUTED}`}>
              {running() ? `${t("chat_worker_state_running")}…` : printed().length > 0 ? "—" : t("chat_worker_no_output")}
            </Text>
          }
        >
          <Each of={answer()} key={(section) => section.kind}>
            {(section) => (
              <View class="gap-1">
                <If when={answer().length > 1}>
                  <Text class={TERMINAL_LABEL}>{t(`chat_worker_section_${section().kind}`)}</Text>
                </If>
                <View
                  selectable
                  class="border-l-2 pl-2.5"
                  style={{ borderColor: section().kind === "error" ? `${NEON.fail}99` : `${tone()}80` }}
                >
                  <TerminalText text={section().text} copyOnly class={`font-mono leading-[18px] ${terminalNoteClass(section().kind === "error")}`} />
                </View>
              </View>
            )}
          </Each>
        </If>
      </View>
    </View>
  );
}
