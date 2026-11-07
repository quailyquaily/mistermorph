// A question the agent asked while working (ask_user). While it is open each choice is a button (or
// its number key while a choice has the keyboard focus) and the field below takes a typed answer;
// once closed it shows the answer. Ported from web/console/src/components/ChatQuestionCard.js.
// The draft, busy and error states are the page's, keyed by question, since rows recycle.
import { cleanup, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { Button } from "../ui";
import { ChatMarkdown } from "./ChatMarkdown";
import { t } from "./i18n";
import type { KeyedState } from "./rowState";

export interface QuestionState {
  draft: string;
  busy: boolean;
  error: string;
}

export interface QuestionAnswer {
  questionID: string;
  option?: number;
  text?: string;
  done: (ok: boolean, message?: string) => void;
}

const EMPTY: QuestionState = { draft: "", busy: false, error: "" };

function Key(props: { label: string; reply?: boolean }) {
  return (
    <View class={`w-16 ${props.reply ? "pt-1.5" : ""}`}>
      <Text class="font-mono text-xs uppercase text-muted-foreground">{props.label}</Text>
    </View>
  );
}

export function ChatQuestionCard(props: {
  question: any;
  /** The task still runs: an open question of an ended task got no answer. */
  live: boolean;
  states: KeyedState<QuestionState>;
  onAnswer: (answer: QuestionAnswer) => void;
}) {
  const id = () => String(props.question?.id ?? "");
  const state = () => props.states.get(id()) ?? EMPTY;
  const patch = (key: string, next: Partial<QuestionState>) =>
    props.states.update(key, (value) => ({ ...(value ?? EMPTY), ...next }));
  const options = (): any[] => (Array.isArray(props.question?.options) ? props.question.options : []);
  const status = () => {
    const value = String(props.question?.status || "");
    if (value === "open" && !props.live) return "expired";
    return value === "open" || value === "answered" ? value : "expired";
  };
  const open = () => status() === "open";
  const answerText = () => String(props.question?.answer || "").trim();
  const choiceFocused = signal(false);

  // A closed question takes no answer: a send it had going ends.
  effect(() => {
    const key = id();
    if (!open()) untracked(() => state().busy && patch(key, { busy: false }));
  });

  function send(answer: { option?: number; text?: string }) {
    const key = id();
    if (!open() || untracked(state).busy) return;
    patch(key, { busy: true, error: "" });
    props.onAnswer({
      questionID: key,
      ...answer,
      done(ok, message) {
        if (ok) patch(key, { busy: false, draft: "" });
        else patch(key, { busy: false, error: message || t("chat_question_closed") });
      },
    });
  }

  const choose = (index: number) => send({ option: index });
  const sendDraft = () => {
    const text = untracked(state).draft.trim();
    if (text) send({ text });
  };

  // The number keys choose while a choice has the keyboard focus, as the card's keydown did.
  effect(() => {
    if (!choiceFocused() || !open()) return;
    const count = Math.min(9, options().length);
    const bindings: Record<string, () => void> = {};
    for (let index = 0; index < count; index += 1) bindings[String(index + 1)] = () => choose(index);
    if (count > 0) cleanup(keymap.bind(bindings, { when: "notEditing" }));
  });

  const placeholder = () => (options().length ? t("chat_question_other_placeholder") : t("chat_question_reply_placeholder"));

  return (
    <View
      class={`gap-2 rounded-(--radius) border bg-card p-3 ${open() ? "border-blue-lighter" : "border-line-faint"}`}
      accessibilityLabel={t("chat_question_title")}
      testID="chat-question"
    >
      <If
        when={open()}
        else={
          <View class="gap-1.5">
            <View class="flex-row gap-2">
              <Key label={t("chat_question_asked")} />
              <Text class="flex-1 text-sm text-foreground">{String(props.question?.text ?? "")}</Text>
            </View>
            <View class="flex-row gap-2">
              <Key label={t("chat_question_you")} />
              <If when={status() === "answered"} else={<Text class="font-mono text-xs uppercase text-muted-foreground">{t("chat_question_no_answer_tag")}</Text>}>
                <Text class="flex-1 text-sm text-foreground">{answerText()}</Text>
              </If>
            </View>
          </View>
        }
      >
        <View class="gap-2">
          <View class="flex-row gap-2">
            <Key label={t("chat_question_asked")} />
            <ChatMarkdown source={String(props.question?.text ?? "")} class="flex-1" />
          </View>
          <Each of={options()} key={(option, index) => `${index}:${option?.label}`}>
            {(option, index) => (
              <View
                role="button"
                disabled={state().busy}
                onPress={() => choose(index())}
                onFocus={() => choiceFocused.set(true)}
                onBlur={() => choiceFocused.set(false)}
                accessibilityLabel={String(option()?.label ?? "")}
                class="flex-row gap-2 rounded-(--radius) px-1 py-1 hover:bg-hover focus:bg-hover disabled:opacity-45"
              >
                <Key label={`[${index() + 1}]`} />
                <View class="flex-1 gap-0.5">
                  <Text class="text-sm font-medium text-foreground">{String(option()?.label ?? "")}</Text>
                  <If when={option()?.description}>
                    <Text class="text-xs text-muted-foreground">{String(option()?.description ?? "")}</Text>
                  </If>
                </View>
              </View>
            )}
          </Each>
          <If when={!props.question?.choices_only}>
            <View class="flex-row items-start gap-2">
              <Key label={t("chat_question_you")} reply />
              <View class="flex-1 flex-row items-center gap-2">
                <Input
                  value={state().draft}
                  onChange={({ value }) => patch(id(), { draft: value })}
                  onSubmit={sendDraft}
                  submitBehavior="submit"
                  returnKeyType="send"
                  placeholder={placeholder()}
                  accessibilityLabel={placeholder()}
                  readonly={state().busy}
                  testID="chat-question-input"
                  class="flex-1 rounded-(--radius) border border-input bg-field px-2.5 py-1.5 text-sm text-foreground placeholder:text-placeholder"
                />
                <Button
                  variant="primary"
                  size="xs"
                  label={t("chat_question_send")}
                  disabled={state().busy || !state().draft.trim()}
                  onPress={sendDraft}
                />
              </View>
            </View>
          </If>
          <If when={state().error}>
            <Text role="alert" class="text-xs text-danger">
              {state().error}
            </Text>
          </If>
        </View>
      </If>
    </View>
  );
}
