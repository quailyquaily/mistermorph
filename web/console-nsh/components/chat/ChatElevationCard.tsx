// An elevated command asking for the sudo password. While open, the password goes to the runtime as
// typed (only as safe as the connection); once closed, the card keeps the command and how it ended.
// Ported from web/console/src/components/ChatElevationCard.js. The field's text is kept per
// request (rows recycle) and cleared as soon as it is sent or the request closes.
import type { InputRef } from "nsh";
import { cleanup, effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { Button } from "../ui";
import { t } from "./i18n";
import type { KeyedState } from "./rowState";

export interface ElevationState {
  password: string;
  busy: boolean;
  error: string;
}

export interface ElevationAnswer {
  elevationID: string;
  password?: string;
  decline?: boolean;
  done: (ok: boolean, message?: string) => void;
}

const EMPTY: ElevationState = { password: "", busy: false, error: "" };
const STATUSES = ["open", "allowed", "declined", "expired", "rejected"];

function Key(props: { label: string }) {
  return (
    <View class="w-20">
      <Text class="font-mono text-xs uppercase text-muted-foreground">{props.label}</Text>
    </View>
  );
}

export function ChatElevationCard(props: {
  elevation: any;
  taskID: string;
  live: boolean;
  states: KeyedState<ElevationState>;
  onAnswer: (answer: ElevationAnswer) => void;
}) {
  let field: InputRef | undefined;
  const id = () => String(props.elevation?.id ?? "");
  const state = () => props.states.get(id()) ?? EMPTY;
  const patch = (key: string, next: Partial<ElevationState>) =>
    props.states.update(key, (value) => ({ ...(value ?? EMPTY), ...next }));
  const status = () => {
    const value = String(props.elevation?.status || "");
    if (value === "open" && !props.live) return "expired";
    return STATUSES.includes(value) ? value : "expired";
  };
  const open = () => status() === "open";
  const now = signal(Date.now());
  const remaining = () => Math.max(0, Math.floor(Number(props.elevation?.deadline || 0) - now() / 1000));
  const remainingText = () => `${Math.floor(remaining() / 60)}:${String(remaining() % 60).padStart(2, "0")}`;
  const retry = () => Number(props.elevation?.attempt || 0) >= 2;

  effect(() => {
    const key = id();
    if (open()) {
      now.set(Date.now());
      const timer = setInterval(() => now.set(Date.now()), 1000);
      cleanup(() => clearInterval(timer));
      return;
    }
    // Closed: nothing to send, and the typed password goes.
    untracked(() => {
      const current = props.states.get(key);
      if (current && (current.busy || current.password)) patch(key, { busy: false, password: "" });
    });
  });

  function send(answer: { password?: string; decline?: boolean }) {
    const key = id();
    if (!open() || untracked(state).busy) return;
    patch(key, { busy: true, error: "" });
    props.onAnswer({
      elevationID: key,
      ...answer,
      done(ok, message) {
        patch(key, { busy: false, error: ok ? "" : message || t("chat_elevation_closed") });
      },
    });
  }

  function allow() {
    const key = id();
    if (!open() || untracked(state).busy || untracked(remaining) <= 0) return;
    const password = untracked(state).password;
    if (password === "") {
      field?.focus();
      return;
    }
    patch(key, { password: "" });
    send({ password });
  }

  function decline() {
    patch(id(), { password: "" });
    send({ decline: true });
  }

  return (
    <View
      class={`gap-2 rounded-(--radius) border bg-card p-3 ${open() ? "border-warn" : "border-line-faint"}`}
      accessibilityLabel={t("chat_elevation_title")}
      testID="chat-elevation"
    >
      <If
        when={open()}
        else={
          <View class="gap-1.5">
            <View class="flex-row gap-2">
              <Key label={t("chat_elevation_command")} />
              <Text class="flex-1 font-mono text-xs text-foreground">{String(props.elevation?.command ?? "")}</Text>
            </View>
            <View class="flex-row gap-2">
              <Key label={t("chat_elevation_outcome")} />
              <Text class="flex-1 text-sm text-foreground">{t(`chat_elevation_${status()}`)}</Text>
            </View>
          </View>
        }
      >
        <View class="gap-2">
          <View class="flex-row items-center gap-2">
            <Key label={t("chat_elevation_label")} />
            <Text class="flex-1 text-sm font-medium text-foreground">{t("chat_elevation_title")}</Text>
            <Text role="timer" class="font-mono text-xs text-warn-dark">
              {t("chat_elevation_time_left", { time: remainingText() })}
            </Text>
          </View>
          <View class="flex-row gap-2">
            <Key label={t("chat_elevation_command")} />
            <View selectable class="flex-1">
              <Text class="font-mono text-xs text-foreground">{String(props.elevation?.command ?? "")}</Text>
            </View>
          </View>
          <If when={props.elevation?.cwd}>
            <View class="flex-row gap-2">
              <Key label={t("chat_elevation_cwd")} />
              <Text class="flex-1 font-mono text-xs text-subtle">{String(props.elevation?.cwd ?? "")}</Text>
            </View>
          </If>
          <If when={props.elevation?.host}>
            <View class="flex-row gap-2">
              <Key label={t("chat_elevation_host")} />
              <Text class="flex-1 font-mono text-xs text-subtle">{String(props.elevation?.host ?? "")}</Text>
            </View>
          </If>
          <If when={retry()}>
            <Text role="alert" class="text-xs text-danger">
              {t("chat_elevation_retry")}
            </Text>
          </If>
          <View class="flex-row items-center gap-2">
            <Key label={t("chat_elevation_password")} />
            <Input
              ref={field}
              masked
              value={state().password}
              onChange={({ value }) => patch(id(), { password: value })}
              onSubmit={allow}
              submitBehavior="submit"
              returnKeyType="send"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("chat_elevation_password_placeholder")}
              accessibilityLabel={t("chat_elevation_password_placeholder")}
              readonly={state().busy || remaining() <= 0}
              testID="chat-elevation-password"
              class="flex-1 rounded-(--radius) border border-input bg-field px-2.5 py-1.5 text-sm text-foreground placeholder:text-placeholder"
            />
            <Button variant="primary" size="xs" label={t("chat_elevation_allow")} disabled={state().busy || remaining() <= 0} onPress={allow} />
            <Button variant="plain" size="xs" label={t("chat_elevation_decline")} disabled={state().busy} onPress={decline} />
          </View>
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
