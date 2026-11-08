// The subagents and coders a task started, below its status card: each a button with its avatar,
// name and state; the selected one shows its PIDs and output, following the end as it grows.
// Ported from web/console/src/components/ChatWorkerRoster.js. Which worker is selected is the
// page's state, keyed by message, since rows recycle.
import { Image, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Tip, TipButton } from "../ui";
import { localeState } from "../../lib/core/context.js";
import { rosterWorkers, workerProcessLabel } from "../../lib/core/chat-workers.js";
import { workerAvatarURL } from "../../lib/core/worker-avatars.js";
import { t } from "./i18n";
import { PinnedScroll } from "./PinnedScroll";
import type { KeyedState } from "./rowState";

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

function WorkerAvatar(props: { avatarStyle: string }) {
  return <Image src={workerAvatarURL(props.avatarStyle)} accessibilityElementsHidden style={{ width: 20, height: 20 }} />;
}

export function ChatWorkerRoster(props: { itemID: string; activity: any; status: string; selected: KeyedState<string> }) {
  const workers = (): any[] => rosterWorkers(props.activity, props.status, localeState.lang);
  const omitted = () => Math.max(0, Number(props.activity?.workersOmitted) || 0);
  const selectedID = () => props.selected.get(props.itemID) ?? "";
  const selected = () => workers().find((worker) => worker.id === selectedID()) ?? null;
  const kindLabel = (worker: any) => (worker?.kind === "coder" ? t("chat_worker_kind_coder") : t("chat_worker_kind_subagent"));
  const stateLabel = (state: string) => t(`chat_worker_state_${state}`);

  return (
    <If when={workers().length > 0}>
      <View class="gap-2" accessibilityLabel={t("chat_workers_title")} testID="chat-worker-roster">
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Each of={workers()} key={(worker) => `${props.itemID}:worker:${worker.id}`}>
            {(worker) => (
              <TipButton
                selected={worker().id === selectedID()}
                onPress={() => props.selected.set(props.itemID, selectedID() === worker().id ? "" : worker().id)}
                accessibilityLabel={`${worker().displayName} · ${kindLabel(worker())} · ${stateLabel(worker().state)}`}
                tooltip={<Tip text={`${worker().displayName} · ${kindLabel(worker())} · ${stateLabel(worker().state)}`} />}
                class="flex-row items-center gap-1.5 rounded-full border border-line-faint bg-card py-0.5 pl-0.5 pr-2 hover:bg-hover selected:border-blue selected:bg-selection"
              >
                <WorkerAvatar avatarStyle={worker().avatarStyle} />
                <Text class="text-xs text-foreground">{worker().displayName}</Text>
                <View class={`size-1.5 rounded-full border ${stateTone(worker().state)}`} />
              </TipButton>
            )}
          </Each>
          <If when={omitted() > 0}>
            <Text class="text-xs text-muted-foreground">{t("chat_workers_omitted", { count: omitted() })}</Text>
          </If>
        </View>
        <If when={selected()}>
          {(worker) => (
            <View class="gap-2 rounded-(--radius) border border-line-faint bg-paper p-3" accessibilityLabel={worker().displayName}>
              <View class="flex-row flex-wrap items-center gap-2">
                <WorkerAvatar avatarStyle={worker().avatarStyle} />
                <Text class="text-sm font-medium text-foreground">{worker().displayName}</Text>
                <Text class="text-xs text-muted-foreground">{kindLabel(worker())}</Text>
                <Text class="font-mono text-xs uppercase text-subtle">{stateLabel(worker().state)}</Text>
                <Each
                  of={Array.isArray(worker().processes) ? worker().processes : []}
                  key={(process: any) => `${process.pid}:${process.program}:${process.activityId}`}
                >
                  {(process) => <Text class="font-mono text-xs text-muted-foreground">{workerProcessLabel(process())}</Text>}
                </Each>
              </View>
              <If
                when={worker().sections.length > 0}
                else={<Text class="text-xs text-muted-foreground">{t("chat_worker_no_output")}</Text>}
              >
                <PinnedScroll resetKey={`${props.itemID}:${worker().id}`} maxHeight={260} contentClass="gap-2">
                  <Each of={worker().sections as any[]} key={(section) => section.kind}>
                    {(section) => (
                      <View class="gap-1">
                        <If when={worker().sections.length > 1}>
                          <Text class="font-mono text-xs uppercase text-muted-foreground">{t(`chat_worker_section_${section().kind}`)}</Text>
                        </If>
                        <View selectable>
                          <Text class={`font-mono text-xs ${section().kind === "error" ? "text-danger" : "text-foreground"}`}>
                            {section().text}
                          </Text>
                        </View>
                      </View>
                    )}
                  </Each>
                </PinnedScroll>
              </If>
            </View>
          )}
        </If>
      </View>
    </If>
  );
}
