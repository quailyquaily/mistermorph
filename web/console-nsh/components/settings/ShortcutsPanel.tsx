// Settings' Keyboard shortcuts section: every action that has a shortcut (lib/shortcuts.ts) with its
// keys here, and the means to change them: record new keys (Escape cancels), remove a shortcut,
// restore one default or all of them. Keys that cannot be used are refused with the reason; keys
// another action has are not taken from it unless the user says so ("Reassign"). Changes save at
// once, for this environment only (the browser and the desktop app each keep their own).
import { cleanup, effect, keymap, platform, signal, Text, untracked, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { navItems } from "../../lib/shell";
import {
  appleKeys,
  checkShortcut,
  currentShortcutEnv,
  defaultShortcutKeys,
  effectiveShortcuts,
  keysLabel,
  loadShortcuts,
  recorderKeystrokes,
  resetAllShortcuts,
  resetShortcut,
  setShortcut,
  setShortcutRecording,
  SHORTCUT_GROUPS,
  shortcutAction,
  shortcutIssue,
  shortcutOverrides,
  type EffectiveBinding,
  type ShortcutGroup,
} from "../../lib/shortcuts";
import { Button, confirm } from "../ui";
import { isMobile } from "../../lib/shell";
import { SettingsCard } from "../settings-page/parts";

const t = translate as unknown as (key: string, vars?: Record<string, unknown>) => string;

/** An action's name as the list shows it ("Go to Contacts"). */
export function shortcutActionTitle(id: string) {
  const action = shortcutAction(id);
  if (!action) return id;
  if (!action.page) return t(action.titleKey);
  const page = navItems().find((item) => item.pagePath === action.page)?.title || action.page.slice(1);
  return t(action.titleKey, { page });
}

/** testIDs: `shortcut-row-chat-newTopic`. */
const idPart = (id: string) => id.replace(/\./g, "-");

type RowMessage =
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "conflict"; keys: string; other: string };

export function ShortcutsPanel() {
  loadShortcuts();
  const recordingID = signal<string | null>(null);
  const message = signal<RowMessage | null>(null);

  // While recording, every key goes to the recorder: the shortcuts hold back
  // (components/frame/shortcutDispatch.ts) and the recorder binds every keystroke but Tab.
  effect(() => {
    const id = recordingID();
    if (!id) return;
    untracked(() => setShortcutRecording(true));
    cleanup(() => setShortcutRecording(false));
    const table: Record<string, (e: { keystroke: string }) => void> = {};
    for (const keys of recorderKeystrokes(appleKeys(), platform.os)) table[keys] = (e) => recorded(e.keystroke);
    table.escape = () => stopRecording();
    try {
      cleanup(keymap.bind(table, { when: "always" }));
    } catch (error) {
      console.warn("keyboard shortcuts: cannot record:", (error as Error)?.message || error);
      untracked(() => recordingID.set(null));
    }
  });

  function startRecording(id: string) {
    message.set(null);
    recordingID.set(id);
  }

  function stopRecording() {
    recordingID.set(null);
  }

  function recorded(keys: string) {
    const id = untracked(recordingID);
    if (!id) return;
    const check = checkShortcut(id, keys);
    if (!check.keys || check.issue?.level === "error") {
      // Still recording: the next keys may do.
      message.set({
        id,
        kind: "error",
        text: t("shortcuts_unavailable", { keys: keysLabel(check.keys || keys), reason: t(check.issue?.reason || "shortcuts_reason_invalid") }),
      });
      return;
    }
    recordingID.set(null);
    if (check.conflict) {
      message.set({ id, kind: "conflict", keys: check.keys, other: check.conflict });
      return;
    }
    message.set(null);
    setShortcut(id, check.keys);
  }

  function reassign(id: string, keys: string, other: string) {
    message.set(null);
    setShortcut(id, keys, other);
  }

  function clear(id: string) {
    if (untracked(recordingID) === id) recordingID.set(null);
    message.set(null);
    setShortcut(id, "");
  }

  function reset(id: string) {
    if (untracked(recordingID) === id) recordingID.set(null);
    if (resetShortcut(id)) {
      message.set(null);
      return;
    }
    const keys = defaultShortcutKeys(id);
    const holder = untracked(effectiveShortcuts).find((binding) => binding.id !== id && binding.keys === keys);
    message.set({
      id,
      kind: "error",
      text: t("shortcuts_reset_blocked", { keys: keysLabel(keys), other: holder ? shortcutActionTitle(holder.id) : "" }),
    });
  }

  async function resetAll() {
    recordingID.set(null);
    const ok = await confirm({
      title: t("shortcuts_reset_all_title"),
      text: t("shortcuts_reset_all_text"),
      confirmLabel: t("shortcuts_reset_all_confirm"),
      cancelLabel: t("action_cancel"),
    });
    if (!ok) return;
    message.set(null);
    resetAllShortcuts();
  }

  const changed = () => Object.keys(shortcutOverrides()).length > 0;
  const envNote = () => t(currentShortcutEnv() === "web" ? "shortcuts_env_web" : "shortcuts_env_desktop");
  const groupBindings = (group: ShortcutGroup) =>
    effectiveShortcuts().filter((binding) => shortcutAction(binding.id)?.group === group);

  return (
    <View class="gap-4" testID="settings-shortcuts">
      <SettingsCard
        title={t("shortcuts_title")}
        meta={envNote()}
        list
        actions={
          <Button
            variant="outlined"
            size="xs"
            label={t("shortcuts_reset_all")}
            disabled={!changed()}
            onPress={() => void resetAll()}
            testID="shortcuts-reset-all"
          />
        }
      >
        <Text class="pt-3 text-xs leading-[18px] text-muted-foreground" testID="shortcuts-hint">
          {t("shortcuts_hint")}
        </Text>
        <Each of={SHORTCUT_GROUPS} key={(group) => group}>
          {(group) => (
            <View class="pt-3" testID={`shortcuts-group-${group()}`}>
              <Text class="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground" role="header">
                {t(`shortcuts_group_${group()}`)}
              </Text>
              <Each of={groupBindings(group())} key={(binding) => binding.id}>
                {(binding) => (
                  <ShortcutRow
                    binding={binding()}
                    recording={recordingID() === binding().id}
                    message={message()?.id === binding().id ? message() : null}
                    onRecord={() => startRecording(binding().id)}
                    onCancel={stopRecording}
                    onClear={() => clear(binding().id)}
                    onReset={() => reset(binding().id)}
                    onReassign={(keys, other) => reassign(binding().id, keys, other)}
                    onDismiss={() => message.set(null)}
                  />
                )}
              </Each>
            </View>
          )}
        </Each>
      </SettingsCard>
    </View>
  );
}

function ShortcutRow(props: {
  binding: EffectiveBinding;
  recording: boolean;
  message: RowMessage | null;
  onRecord: () => void;
  onCancel: () => void;
  onClear: () => void;
  onReset: () => void;
  onReassign: (keys: string, other: string) => void;
  onDismiss: () => void;
}) {
  const id = () => props.binding.id;
  const title = () => shortcutActionTitle(id());
  const label = () => keysLabel(props.binding.keys);
  const custom = () => props.binding.source !== "default";
  const state = () => t(`shortcuts_state_${props.binding.source}`);
  // What to know about the keys it has now (a browser feature they replace, a limit).
  const issue = () => (props.binding.keys ? shortcutIssue(props.binding.keys, currentShortcutEnv(), appleKeys()) : null);
  const issueText = () => {
    const current = issue();
    if (!current || current.level === "error") return "";
    if (current.reason.startsWith("shortcuts_browser_")) return t("shortcuts_browser_warning", { what: t(current.reason) });
    return t(current.reason);
  };
  const shadowText = () =>
    props.binding.shadowedBy ? t("shortcuts_shadowed", { other: shortcutActionTitle(props.binding.shadowedBy) }) : "";
  const conflict = () => (props.message?.kind === "conflict" ? props.message : null);
  const errorText = () => (props.message?.kind === "error" ? props.message.text : "");
  const part = idPart(props.binding.id);
  return (
    <View
      class={`gap-2 border-t border-line-soft py-3 ${isMobile() ? "" : "flex-row items-start"}`}
      testID={`shortcut-row-${part}`}
    >
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-sm font-medium leading-[18.9px] text-foreground">{title()}</Text>
        <Text class="text-xs leading-[17.4px] text-muted-foreground" testID={`shortcut-state-${part}`}>
          {state()}
        </Text>
        <If when={props.recording}>
          <View android={{ accessibilityLiveRegion: "polite" }}>
            <Text class="text-xs leading-[17.4px] text-blue-dark" testID={`shortcut-recording-${part}`}>
              {t("shortcuts_recording")}
            </Text>
          </View>
        </If>
        <If when={errorText()}>
          <View android={{ accessibilityLiveRegion: "polite" }}>
            <Text class="text-xs leading-[17.4px] text-danger" testID={`shortcut-error-${part}`}>
              {errorText()}
            </Text>
          </View>
        </If>
        <If when={conflict()}>
          {(current) => (
            <View class="gap-2" android={{ accessibilityLiveRegion: "polite" }} testID={`shortcut-conflict-${part}`}>
              <Text class="text-xs leading-[17.4px] text-danger">
                {t("shortcuts_conflict", {
                  keys: keysLabel(current().keys),
                  other: shortcutActionTitle(current().other),
                  action: title(),
                })}
              </Text>
              <View class="flex-row flex-wrap gap-2">
                <Button
                  variant="outlined"
                  size="xs"
                  label={t("shortcuts_reassign")}
                  accessibilityLabel={t("shortcuts_reassign_label", {
                    keys: keysLabel(current().keys),
                    action: title(),
                    other: shortcutActionTitle(current().other),
                  })}
                  onPress={() => props.onReassign(current().keys, current().other)}
                  testID={`shortcut-reassign-${part}`}
                />
                <Button variant="plain" size="xs" label={t("action_cancel")} onPress={props.onDismiss} testID={`shortcut-dismiss-${part}`} />
              </View>
            </View>
          )}
        </If>
        <If when={shadowText()}>
          <Text class="text-xs leading-[17.4px] text-danger" testID={`shortcut-shadowed-${part}`}>
            {shadowText()}
          </Text>
        </If>
        <If when={issueText()}>
          <Text
            class={`text-xs leading-[17.4px] ${issue()?.level === "warning" ? "text-warn-dark" : "text-muted-foreground"}`}
            testID={`shortcut-issue-${part}`}
          >
            {issueText()}
          </Text>
        </If>
      </View>
      <View class="flex-row flex-wrap items-center gap-2">
        <View
          class={`min-h-8 min-w-16 items-center justify-center rounded-(--radius) border px-2.5 ${
            props.recording ? "border-blue bg-selection" : "border-line-soft bg-field"
          }`}
          accessibilityLabel={label() ? t("shortcuts_keys_label", { action: title(), keys: label() }) : t("shortcuts_none_label", { action: title() })}
          testID={`shortcut-keys-${part}`}
        >
          <Text class={`font-mono text-xs ${label() ? "text-foreground" : "text-muted-foreground"}`}>
            {props.recording ? "…" : label() || t("shortcuts_none")}
          </Text>
        </View>
        <If
          when={props.recording}
          else={
            <Button
              variant="outlined"
              size="xs"
              label={t("shortcuts_change")}
              accessibilityLabel={t("shortcuts_change_label", { action: title() })}
              onPress={props.onRecord}
              testID={`shortcut-change-${part}`}
            />
          }
        >
          <Button
            variant="outlined"
            size="xs"
            label={t("action_cancel")}
            accessibilityLabel={t("shortcuts_cancel_label", { action: title() })}
            onPress={props.onCancel}
            testID={`shortcut-cancel-${part}`}
          />
        </If>
        <Button
          variant="plain"
          size="xs"
          label={t("shortcuts_clear")}
          accessibilityLabel={t("shortcuts_clear_label", { action: title() })}
          disabled={!props.binding.keys}
          onPress={props.onClear}
          testID={`shortcut-clear-${part}`}
        />
        <If when={custom()}>
          <Button
            variant="plain"
            size="xs"
            label={t("shortcuts_reset")}
            accessibilityLabel={t("shortcuts_reset_label", {
              action: title(),
              keys: keysLabel(defaultShortcutKeys(id())) || t("shortcuts_none"),
            })}
            onPress={props.onReset}
            testID={`shortcut-reset-${part}`}
          />
        </If>
      </View>
    </View>
  );
}

