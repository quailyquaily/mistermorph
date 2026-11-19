// A reply's processes, on the detail panel's terminal (pages/chat/ActivityDetailPanel.tsx): what
// its shell commands and coders have running now, as trees under the call that started them, and
// what was stopped (by the sweep at the end of the task, or here). The server finds them
// (internal/proctrack): a command's leftovers by the tags it started with, after their parent has
// gone; a coder server's helpers under the server.
//
// It draws the task's shared reading of GET /tasks/{id}/processes (taskProcesses.ts), read again
// every couple of seconds while it is open, and each process has a Stop that ends it and what it
// started (POST /tasks/{id}/processes/kill). The reply's Processes column shows only while a
// process runs; once a read finds none left, `onEnded` says so (the page closes the panel).
import { cleanup, effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { runtimeApiFetchForEndpoint } from "../../lib/core/context.js";
import { t } from "./i18n";
import { KindChip, NEON } from "./TerminalText";
import { TERMINAL_ERROR, TERMINAL_FG, TERMINAL_LABEL, TERMINAL_MUTED, TERMINAL_NOTE } from "./ChatTerminal";
import { refreshTaskProcesses, watchTaskProcesses, type ProcNode } from "./taskProcesses";

/** How long after a Stop pressed here the last process ending counts as the Stop's doing. */
const STOP_ENDS_MS = 10_000;

function clock(raw: string) {
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function countNodes(nodes: ProcNode[] | undefined): number {
  return (nodes ?? []).reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

export function ChatProcessTree(props: {
  endpointRef: string;
  taskID: string;
  /**
   * A read found no process of the task running (after one did, or as the panel opened on a
   * task whose processes have all gone): `byStop` when a Stop pressed here just ended the last.
   */
  onEnded?: (byStop: boolean) => void;
}) {
  const reading = watchTaskProcesses(
    () => props.endpointRef,
    () => props.taskID,
    { fast: () => true },
  );
  const tree = () => reading().tree;
  const stopError = signal("");
  const error = () => stopError() || reading().error;
  const stopping = signal<Record<number, boolean>>({});
  let lastStop = 0;
  let alive = true;
  cleanup(() => (alive = false));

  // Another task (or endpoint) starts clean: its own reading, no Stop of the last one pending.
  effect(() => {
    void props.endpointRef;
    void props.taskID;
    untracked(() => {
      stopError.set("");
      stopping.set({});
      lastStop = 0;
    });
  });

  // A successful read with nothing running ends the panel's reason to be open.
  effect(() => {
    const state = reading();
    if (!state.loaded || state.error || state.live) return;
    untracked(() => props.onEnded?.(lastStop > 0 && Date.now() - lastStop < STOP_ENDS_MS));
  });

  async function stop(pid: number) {
    const endpointRef = props.endpointRef;
    const taskID = props.taskID;
    stopping.set({ ...stopping(), [pid]: true });
    stopError.set("");
    lastStop = Date.now();
    let failure = "";
    try {
      await runtimeApiFetchForEndpoint(endpointRef, `/tasks/${encodeURIComponent(taskID)}/processes/kill`, { method: "POST", body: { pid } });
    } catch (err) {
      failure = String((err as Error)?.message || err);
    }
    if (!alive || endpointRef !== props.endpointRef || taskID !== props.taskID) return;
    const next = { ...stopping() };
    delete next[pid];
    stopping.set(next);
    if (failure) stopError.set(failure);
    await refreshTaskProcesses(endpointRef, taskID);
    // As before: a read that succeeds after a failed Stop shows the tree as it is now instead.
    if (alive && failure && !untracked(reading).error && endpointRef === props.endpointRef && taskID === props.taskID) stopError.set("");
  }

  const groups = () => tree()?.groups ?? [];
  const other = () => tree()?.other ?? [];
  const stopped = () => tree()?.stopped ?? [];
  const nothing = () => groups().length === 0 && other().length === 0;

  return (
    <View class="gap-3" testID="chat-process-tree">
      <If when={error()}>
        <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_ERROR}`} testID="chat-process-error">
          {error()}
        </Text>
      </If>
      <If when={tree()}>
        {(data) => (
          <View class="gap-3">
            <If when={!data().supported}>
              <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_MUTED}`} testID="chat-process-unsupported">
                {t("chat_processes_unsupported")}
              </Text>
            </If>
            <If when={data().supported && !data().known}>
              <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_MUTED}`} testID="chat-process-unknown">
                {t("chat_processes_unknown")}
              </Text>
            </If>
            <If when={data().supported && data().known && nothing()}>
              <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_MUTED}`} testID="chat-process-none">
                {t("chat_processes_none")}
              </Text>
            </If>
            <Each of={groups()} key={(group) => `${group.pid}:${group.activity_id ?? ""}`}>
              {(group) => (
                <View class="gap-1" testID="chat-process-group">
                  <View class="flex-row flex-wrap items-center gap-2">
                    <KindChip label={group().kind === "coder" ? t("chat_processes_kind_coder") : t("chat_processes_kind_shell")} tone={group().kind === "coder" ? "violet" : "cyan"} />
                    <Text class={`font-mono text-[13px] font-medium leading-[18px] ${TERMINAL_FG}`}>{group().program}</Text>
                    <Text class={`font-mono text-[11px] ${TERMINAL_MUTED}`}>{t("chat_processes_count", { count: countNodes(group().processes) })}</Text>
                    <If when={group().keep}>
                      <Text class="font-mono text-[11px]" style={{ color: NEON.amber }} testID="chat-process-kept">
                        {t("chat_processes_kept")}
                      </Text>
                    </If>
                  </View>
                  <ProcessRows nodes={group().processes ?? []} prefix="" stopping={stopping()} onStop={stop} />
                </View>
              )}
            </Each>
            <If when={other().length > 0}>
              <View class="gap-1">
                <Text class={TERMINAL_LABEL}>{t("chat_processes_other")}</Text>
                <ProcessRows nodes={other()} prefix="" stopping={stopping()} onStop={stop} />
              </View>
            </If>
            <If when={stopped().length > 0}>
              <View class="gap-1" testID="chat-process-stopped">
                <Text class={TERMINAL_LABEL}>{t("chat_processes_stopped")}</Text>
                <Each of={stopped()} key={(entry) => `${entry.pid}:${entry.at}`}>
                  {(entry) => (
                    <View class="flex-row flex-wrap items-center gap-2">
                      <Text class="font-mono text-[11px]" style={{ color: NEON.idle }}>
                        {clock(entry().at)}
                      </Text>
                      <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_NOTE}`}>{`${entry().pid} ${entry().name}`}</Text>
                      <Text class={`font-mono text-[11px] ${TERMINAL_MUTED}`}>
                        {entry().by === "user" ? t("chat_processes_by_user") : t("chat_processes_by_sweep")}
                      </Text>
                      <If when={entry().error}>
                        <Text class={`font-mono text-[11px] ${TERMINAL_ERROR}`}>{entry().error}</Text>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
        )}
      </If>
    </View>
  );
}

/** Processes as a tree: `├─`/`└─`, the pid and name, its command, and Stop. */
function ProcessRows(props: { nodes: ProcNode[]; prefix: string; stopping: Record<number, boolean>; onStop: (pid: number) => void }) {
  return (
    <View class="gap-0.5">
      <Each of={props.nodes} key={(node) => `${node.pid}:${node.started_at}`}>
        {(node, index) => {
          const last = () => index() === props.nodes.length - 1;
          return (
            <View class="gap-0.5" testID="chat-process-row">
              <View class="flex-row items-start gap-1.5">
                <Text class="font-mono text-xs leading-[18px]" style={{ color: NEON.idle }}>
                  {`${props.prefix}${last() ? "└─" : "├─"}`}
                </Text>
                <View class="min-w-0 flex-1 gap-0.5">
                  <View class="flex-row flex-wrap items-center gap-2">
                    <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_FG}`}>{`${node().pid} ${node().name}`}</Text>
                    <If when={node().orphan}>
                      <Text class="font-mono text-[11px]" style={{ color: NEON.orange }} testID="chat-process-orphan">
                        {t("chat_processes_orphan")}
                      </Text>
                    </If>
                    <Text class="font-mono text-[11px]" style={{ color: NEON.idle }}>
                      {clock(node().started_at)}
                    </Text>
                    <View class="flex-1" />
                    <BaseButton
                      onPress={() => props.onStop(node().pid)}
                      disabled={Boolean(props.stopping[node().pid])}
                      accessibilityLabel={t("chat_processes_stop_label", { pid: node().pid })}
                      testID="chat-process-stop"
                      class="h-5 items-center justify-center rounded-[2px] border px-1.5 hover:bg-white/8"
                      style={{ borderColor: `${NEON.fail}66` }}
                    >
                      <Text class="font-mono text-[10px] leading-[14px]" style={{ color: NEON.fail }}>
                        {props.stopping[node().pid] ? t("chat_processes_stopping") : t("chat_processes_stop")}
                      </Text>
                    </BaseButton>
                  </View>
                  <If when={node().command}>
                    <View selectable>
                      <Text class={`font-mono text-[11px] leading-[16px] ${TERMINAL_MUTED}`}>{node().command}</Text>
                    </View>
                  </If>
                </View>
              </View>
              <If when={(node().children ?? []).length > 0}>
                <ProcessRows nodes={node().children ?? []} prefix={`${props.prefix}${last() ? "   " : "│  "}`} stopping={props.stopping} onStop={props.onStop} />
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
