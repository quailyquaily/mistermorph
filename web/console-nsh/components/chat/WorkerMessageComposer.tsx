// Sending one of a task's running subagents a message, from its panel (pages/chat/ActivityDetailPanel.tsx):
// a field and a send button at the panel's foot. The runtime queues the message for that worker
// (POST /tasks with `steer_target_child_id`), which takes it in at its next step, never in the middle
// of a model call or a tool; the worker's record (ChatWorkerOutput) shows it queued, then applied at
// that step. A coder runs an external CLI that cannot take a message mid-run: its panel says so and
// has no field; a finished worker's panel has neither.
//
// A worker that finishes between the panel's render and the send refuses the message: the draft stays,
// and the panel offers to send it to the main agent instead. It is never sent there on its own.
//
// Drafts and the messages sent from here that the runtime has not reported yet live in this module,
// by task and worker, so they outlast the panel closing and rows recycling.
import type { InputRef } from "nsh";
import { batch, effect, Image, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { Button, Icon, Tip, TipButton } from "../ui";
import { ICONS } from "../icons";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import { TERMINAL_ERROR, TERMINAL_FG, TERMINAL_MUTED } from "./ChatTerminal";
import { t } from "./i18n";

/** What became of a message sent to a worker: queued, or refused (`code`, as the runtime names it). */
export type WorkerSendOutcome = { ok: true } | { ok: false; code: string; message: string };

/** Sends `text` to worker `workerID` of the reply's task. */
export type WorkerSend = (workerID: string, text: string) => Promise<WorkerSendOutcome>;

/** Sends `text` to the main agent, as a message in the conversation; resolves whether it was taken. */
export type ParentSend = (text: string) => Promise<boolean>;

type PendingMessage = { id: string; text: string; at: string };

const drafts = new Map<string, string>();
const pendingMessages = signal<Record<string, PendingMessage[]>>({});
let pendingSeq = 0;

/** The key of a worker's draft and pending messages: its task (or reply) and its ID. */
export function workerMessageKey(taskKey: string, workerID: string) {
  return `${taskKey}:${workerID}`;
}

/** The messages sent to the worker of `key` that the runtime has not reported yet, oldest first. */
export function pendingWorkerMessages(key: string): PendingMessage[] {
  return pendingMessages()[key] ?? [];
}

function addPending(key: string, text: string) {
  const entry = { id: `pending-${++pendingSeq}`, text, at: new Date().toISOString() };
  pendingMessages.set({ ...untracked(pendingMessages), [key]: [...(untracked(pendingMessages)[key] ?? []), entry] });
}

/** Drops the pending messages of `key` the runtime has reported (`workerMessageList`'s `settled`). */
export function settlePendingWorkerMessages(key: string, settled: string[]) {
  if (settled.length === 0) return;
  const current = untracked(pendingMessages)[key] ?? [];
  const left = current.filter((message) => !settled.includes(message.id));
  if (left.length === current.length) return;
  pendingMessages.set({ ...untracked(pendingMessages), [key]: left });
}

/** A refusal the person can answer by sending the message to the main agent instead. */
const PARENT_FALLBACK = new Set(["child_finished", "no_active_run", "child_not_found"]);

export function WorkerMessageComposer(props: {
  /** The key of this worker's draft and pending messages (workerMessageKey). */
  messageKey: string;
  workerID: string;
  /** The worker's name, as its panel shows it. */
  name: string;
  /** Drawn on the terminal's dark ink (the workbench). */
  dark?: boolean;
  onSend: WorkerSend;
  onSendToParent?: ParentSend;
  /** Where its field and button lie (tests): `worker-message`, `-field`, `-send`. */
  onPartLayout?: PartLayoutListener;
}) {
  const draft = signal(drafts.get(props.messageKey) ?? "");
  const sending = signal(false);
  const refusal = signal<{ code: string; message: string } | null>(null);
  const notice = signal("");
  effect(() => {
    // Another worker in the same panel: its own draft.
    const key = props.messageKey;
    batch(() => {
      draft.set(drafts.get(key) ?? "");
      refusal.set(null);
      notice.set("");
    });
  });
  const setDraft = (value: string) => {
    drafts.set(untracked(() => props.messageKey), value);
    draft.set(value);
  };
  let field: InputRef | undefined;
  const probe = createPartProbe(() => props.onPartLayout);
  const canSend = () => draft().trim() !== "" && !sending();

  async function send() {
    const text = untracked(draft).trim();
    if (!text || untracked(sending)) return;
    const key = untracked(() => props.messageKey);
    batch(() => {
      sending.set(true);
      refusal.set(null);
      notice.set("");
    });
    try {
      const outcome = await props.onSend(untracked(() => props.workerID), text);
      if (outcome.ok) {
        addPending(key, text);
        drafts.delete(key);
        if (untracked(() => props.messageKey) === key) draft.set("");
      } else if (untracked(() => props.messageKey) === key) {
        // The draft stays: the person decides where it goes now.
        refusal.set({ code: outcome.code, message: outcome.message });
      }
    } finally {
      sending.set(false);
    }
  }

  async function sendToParent() {
    const text = untracked(draft).trim();
    if (!text || !props.onSendToParent || untracked(sending)) return;
    const key = untracked(() => props.messageKey);
    sending.set(true);
    try {
      const accepted = await props.onSendToParent(text);
      if (accepted && untracked(() => props.messageKey) === key) {
        drafts.delete(key);
        batch(() => {
          draft.set("");
          refusal.set(null);
          notice.set(t("chat_worker_message_sent_to_parent"));
        });
      }
    } finally {
      sending.set(false);
    }
  }

  const refusalText = () => {
    const failed = refusal();
    if (!failed) return "";
    if (PARENT_FALLBACK.has(failed.code)) return t("chat_worker_message_finished", { name: props.name });
    if (failed.code === "child_unsupported") return t("chat_worker_message_coder", { name: props.name });
    return t("chat_worker_message_failed", { error: failed.message });
  };
  const offersParent = () => Boolean(props.onSendToParent) && PARENT_FALLBACK.has(refusal()?.code ?? "");
  const muted = () => (props.dark ? TERMINAL_MUTED : "text-muted-foreground");

  return (
    <View class={`gap-2 border-t px-4 pb-3 pt-2.5 ${props.dark ? "border-white/10" : "border-line-faint"}`} testID="chat-worker-message" {...probe.probe(() => "worker-message")}>
      <If when={refusalText()}>
        <View class="gap-1.5" testID="chat-worker-message-refused">
          <Text class={`text-xs leading-[18px] ${props.dark ? TERMINAL_ERROR : "text-danger"}`} testID="chat-worker-message-error">
            {refusalText()}
          </Text>
          <If when={offersParent()}>
            <Button
              label={t("chat_worker_message_to_parent")}
              variant="outlined"
              size="xs"
              class="self-start"
              disabled={sending()}
              onPress={() => void sendToParent()}
              testID="chat-worker-message-to-parent"
            />
          </If>
        </View>
      </If>
      <If when={notice()}>
        <Text class={`text-xs ${muted()}`} testID="chat-worker-message-notice">
          {notice()}
        </Text>
      </If>
      <View class="flex-row items-center gap-2">
        <View
          class={`min-w-0 flex-1 rounded-(--radius) border ${props.dark ? "border-white/15 bg-white/6" : "border-input bg-field"}`}
          {...probe.probe(() => "worker-message-field")}
        >
          <Input
            ref={(node: InputRef) => (field = node)}
            value={draft()}
            onChange={({ value }) => setDraft(value)}
            onSubmit={() => void send()}
            submitBehavior="submit"
            returnKeyType="send"
            placeholder={t("chat_worker_message_placeholder", { name: props.name })}
            accessibilityLabel={t("chat_worker_message_placeholder", { name: props.name })}
            autoCapitalize="sentences"
            testID="chat-worker-message-input"
            class={`min-w-0 self-stretch px-3 py-2 text-sm ${props.dark ? `${TERMINAL_FG} placeholder:text-[#d5e0ec80]` : "text-foreground placeholder:text-placeholder"} caret-blue`}
          />
        </View>
        <View class="shrink-0" {...probe.probe(() => "worker-message-send")}>
          <TipButton
            accessibilityLabel={t("chat_worker_message_send", { name: props.name })}
            tooltip={<Tip text={t("chat_worker_message_send", { name: props.name })} />}
            disabled={!canSend()}
            onPress={() => {
              void send();
              field?.focus();
            }}
            testID="chat-worker-message-send"
            class={`size-9 items-center justify-center rounded-full transition-colors duration-[180ms] disabled:opacity-50 ${
              props.dark ? "bg-white/12 hover:bg-white/20" : "bg-blue active:opacity-80"
            }`}
          >
            {/* On the dark panel the terminal's light ink (no theme token is light on it). */}
            <If when={props.dark} else={<Icon name="PhPaperPlaneTilt" size={16} color="primary-foreground" />}>
              <Image class="overflow-hidden" src={ICONS.PhPaperPlaneTilt} accessibilityElementsHidden style={{ width: 16, height: 16, tintColor: "#e8eef5" }} />
            </If>
          </TipButton>
        </View>
      </View>
    </View>
  );
}

/** A running coder's panel foot: why it has no field. */
export function WorkerMessageUnavailable(props: { name: string; dark?: boolean }) {
  return (
    <View class={`border-t px-4 pb-3 pt-2.5 ${props.dark ? "border-white/10" : "border-line-faint"}`} testID="chat-worker-message-coder">
      <Text class={`text-xs leading-[18px] ${props.dark ? TERMINAL_MUTED : "text-muted-foreground"}`}>{t("chat_worker_message_coder", { name: props.name })}</Text>
    </View>
  );
}
