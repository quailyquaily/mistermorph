// The chat's message field (the Vue console's ChatComposer): a growing text field that sends on
// Enter (on desktops; Shift+Enter for a new line), `/` commands and `$` skills offered as you type
// (arrows, Enter or Tab, Escape), Up and Down through what you sent before, attached files with
// their upload state, the add menu (upload files, attach a workspace), the model picker, voice
// input, and Send that turns into Stop while a reply runs.
//
// Not ported: the coloured overlay that marked command and skill tokens inside the text (a native
// text field draws its own text; nothing can be laid exactly over it).
import type { InputRef, JSX } from "nsh";
import { cleanup, effect, Image, keymap, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input, Select } from "nsh/base";
import { Button, DropdownMenu, Icon, type IconName } from "../ui";
import {
  buildComposerSuggestionItems,
  composerSuggestionInsertText,
  composerTriggerContext,
  replaceComposerSuggestionToken,
} from "../../lib/core/chat-composer-suggestions.js";
import { t } from "./i18n";

const DEFAULT_MAX_ROWS = 24;
const LINE_HEIGHT = 20;

export interface ComposerFileItem {
  id: string;
  name: string;
  status: "uploading" | "ready" | "failed" | string;
  error?: string;
  sourceFile?: unknown;
  [key: string]: unknown;
}

export interface ComposerProfileItem {
  id: string;
  title: string;
  subtitle?: string;
  value: string;
  image?: string;
  icon?: string;
}

export interface ComposerHandle {
  focus: (options?: { preserveSelection?: boolean }) => void;
  insertText: (text: string) => void;
  closeSuggestions: () => void;
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  sendDisabled?: boolean;
  sending?: boolean;
  stopMode?: boolean;
  attachActive?: boolean;
  attachDisabled?: boolean;
  addLabel?: string;
  attachLabel?: string;
  uploadLabel?: string;
  uploading?: boolean;
  fileItems?: ComposerFileItem[];
  fileLabels?: { files: string; preview: string; remove: string; uploading: string; failed: string; retry: string };
  sendLabel?: string;
  submitOnEnter?: boolean;
  inputHistory?: string[];
  commands?: any[];
  skills?: any[];
  skillsLoading?: boolean;
  skillsError?: string;
  suggestionLabels?: { commands: string; skills: string; loading: string; empty: string };
  llmProfileItems?: ComposerProfileItem[];
  llmProfileValue?: string;
  llmProfileLabel?: string;
  onLLMProfileChange?: (value: string) => void;
  footerText?: string;
  landing?: boolean;
  voiceAvailable?: boolean;
  voiceState?: "idle" | "recording" | "transcribing";
  voiceLabel?: string;
  voiceElapsed?: number;
  voicePreview?: string;
  /** null when there is no live preview. */
  voicePreviewEnabled?: boolean | null;
  voiceLabels?: { recording: string; transcribing: string; discard: string; previewOn: string; previewOff: string };
  onSubmit?: () => void;
  onStop?: () => void;
  onAttach?: () => void;
  onUpload?: () => void;
  onAttachFiles?: (files: File[]) => void;
  onRetryFile?: (item: ComposerFileItem) => void;
  onVoice?: () => void;
  onVoiceCancel?: () => void;
  onVoicePreviewToggle?: () => void;
  onPreviewFile?: (item: ComposerFileItem) => void;
  onRemoveFile?: (item: ComposerFileItem) => void;
  onRequestCommands?: () => void;
  onRequestSkills?: () => void;
  onReady?: (handle: ComposerHandle) => void;
  testID?: string;
}

function sameContext(a: any, b: any) {
  return a?.type === b?.type && a?.query === b?.query && a?.start === b?.start && a?.end === b?.end;
}

/** Images pasted without a name get one, as the Vue console's clipboardImageFiles did. */
function namedImages(files: File[]) {
  return files
    .filter((file) => String(file?.type || "").startsWith("image/"))
    .map((file, index) => {
      if (file.name) return file;
      const subtype = file.type.slice("image/".length).split("+")[0];
      const extension = subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "");
      return new File([file], `clipboard-image-${index + 1}.${extension || "img"}`, { type: file.type });
    });
}

export function ChatComposer(props: ChatComposerProps) {
  let field: InputRef | undefined;
  const selection = signal({ start: 0, end: 0 });
  const focused = signal(false);
  const suggestionContext = signal<any>(null);
  const suggestionIndex = signal(0);
  const historyIndex = signal(-1);
  const contentHeight = signal(LINE_HEIGHT);
  let applyingHistory = false;

  const value = () => String(props.value ?? "");
  const history = () => (Array.isArray(props.inputHistory) ? props.inputHistory : []).map((item) => String(item ?? "").trim()).filter(Boolean);
  const labels = () => props.suggestionLabels ?? { commands: "Commands", skills: "Skills", loading: "Loading...", empty: "No matches" };
  const fileLabels = () =>
    props.fileLabels ?? { files: "Attached files", preview: "Preview file", remove: "Remove from task", uploading: "Uploading...", failed: "Upload failed", retry: "Retry upload" };
  const voiceLabels = () =>
    props.voiceLabels ?? { recording: "Listening...", transcribing: "Transcribing...", discard: "Discard recording", previewOn: "Show live text", previewOff: "Hide live text" };
  const suggestionItems = (): any[] => (buildComposerSuggestionItems as (options: unknown) => any[])({ context: suggestionContext(), commands: props.commands, skills: props.skills });
  const suggestionsVisible = () => suggestionContext() !== null;
  const activeIndex = () => {
    const count = suggestionItems().length;
    return count === 0 ? 0 : Math.min(suggestionIndex(), count - 1);
  };
  const suggestionTitle = () => (suggestionContext()?.type === "skill" ? labels().skills : labels().commands);
  const suggestionEmpty = () => {
    if (suggestionContext()?.type === "skill" && props.skillsLoading) return labels().loading;
    if (suggestionContext()?.type === "skill" && props.skillsError) return props.skillsError;
    return labels().empty;
  };
  const voiceActive = () => props.voiceState === "recording" || props.voiceState === "transcribing";
  const voiceElapsedText = () => {
    const total = Math.max(0, Math.floor(Number(props.voiceElapsed) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };
  const voiceStatusText = () =>
    props.voicePreview || (props.voiceState === "transcribing" ? voiceLabels().transcribing : voiceLabels().recording);
  const profiles = () => props.llmProfileItems ?? [];
  const selectedProfile = () => {
    const current = String(props.llmProfileValue ?? "").trim();
    return profiles().find((item) => String(item.value ?? "").trim() === current) ?? profiles()[0] ?? null;
  };
  const profileTitle = () => {
    const label = String(props.llmProfileLabel ?? "").trim();
    const chosen = String(selectedProfile()?.title ?? "").trim();
    return label && chosen ? `${label}: ${chosen}` : label || chosen;
  };
  const maxHeight = () => DEFAULT_MAX_ROWS * LINE_HEIGHT;
  const fieldHeight = () => Math.max(LINE_HEIGHT, Math.min(contentHeight(), maxHeight()));
  // Enter sends on desktops; while suggestions show it picks one, also on phones.
  const submitBehavior = () => (props.submitOnEnter !== false || suggestionsVisible() ? "submit" : "newline");

  function closeSuggestions() {
    suggestionContext.set(null);
    suggestionIndex.set(0);
  }

  function syncSuggestions(text: string, cursor: number) {
    if (props.disabled) {
      closeSuggestions();
      return;
    }
    const next = composerTriggerContext(text, Math.min(cursor, text.length));
    if (!next) {
      closeSuggestions();
      return;
    }
    if (!sameContext(untracked(suggestionContext), next)) suggestionIndex.set(0);
    suggestionContext.set(next);
    if (next.type === "command") props.onRequestCommands?.();
    else if (next.type === "skill") props.onRequestSkills?.();
  }

  function resetHistory() {
    historyIndex.set(-1);
  }

  function setCaret(offset: number) {
    setTimeout(() => {
      field?.focus();
      field?.setSelection(offset, offset);
    }, 0);
  }

  function focus(options: { preserveSelection?: boolean } = {}) {
    if (props.disabled) return;
    setTimeout(() => {
      field?.focus();
      if (!options.preserveSelection) {
        const length = untracked(value).length;
        field?.setSelection(length, length);
      }
    }, 0);
  }

  function insertText(raw: string) {
    const text = String(raw ?? "");
    if (!text) return;
    resetHistory();
    const current = untracked(value);
    let start = current.length;
    let end = current.length;
    if (untracked(focused)) {
      const range = untracked(selection);
      start = Math.min(range.start, current.length);
      end = Math.min(Math.max(range.end, start), current.length);
    }
    props.onChange(`${current.slice(0, start)}${text}${current.slice(end)}`);
    setCaret(start + text.length);
  }

  function applySuggestion(item = suggestionItems()[activeIndex()]) {
    if (!item) return;
    const text = untracked(value);
    const context = composerTriggerContext(text, Math.min(untracked(selection).end, text.length)) || untracked(suggestionContext);
    if (!context) {
      closeSuggestions();
      return;
    }
    const insert = composerSuggestionInsertText(item.insertText || item.value || item.title);
    const next = replaceComposerSuggestionToken(text, context, insert);
    resetHistory();
    props.onChange(next);
    closeSuggestions();
    setCaret(context.start + insert.length);
  }

  function applyHistory(index: number, text: string) {
    historyIndex.set(index);
    applyingHistory = true;
    props.onChange(text);
    applyingHistory = false;
    setCaret(text.length);
  }

  function historyStep(direction: "up" | "down") {
    const items = history();
    if (!items.length || props.disabled) return;
    const current = untracked(value);
    const index = untracked(historyIndex);
    const browsing = index >= 0 && current === items[index];
    if (!browsing && (current !== "" || direction === "down")) {
      resetHistory();
      return;
    }
    const next = direction === "up" ? (browsing ? Math.min(index + 1, items.length - 1) : 0) : Math.max(index - 1, -1);
    if (browsing && next === index) return;
    if (next < 0) {
      resetHistory();
      applyingHistory = true;
      props.onChange("");
      applyingHistory = false;
      return;
    }
    applyHistory(next, items[next]);
  }

  // The keys the field lends: the suggestion list's while it shows, else Up and Down through the
  // messages sent before while the field is empty or showing one of them.
  effect(() => {
    if (!focused() || props.disabled) return;
    if (suggestionsVisible()) {
      const move = (step: number) => {
        const count = suggestionItems().length;
        if (count > 0) suggestionIndex.set((untracked(activeIndex) + step + count) % count);
      };
      cleanup(
        keymap.bind(
          {
            up: () => move(-1),
            down: () => move(1),
            tab: () => applySuggestion(),
            escape: () => closeSuggestions(),
          },
          { when: "always" },
        ),
      );
      return;
    }
    const items = history();
    if (!items.length) return;
    const index = historyIndex();
    const browsing = index >= 0 && value() === items[index];
    if (value() === "" || browsing) cleanup(keymap.bind("up", () => historyStep("up"), { when: "always" }));
    if (browsing) cleanup(keymap.bind("down", () => historyStep("down"), { when: "always" }));
  });

  // Typing other text leaves the sent message being browsed.
  effect(() => {
    const text = value();
    untracked(() => {
      const index = historyIndex();
      if (!applyingHistory && index >= 0 && text !== history()[index]) resetHistory();
    });
  });

  effect(() => {
    if (props.disabled) untracked(closeSuggestions);
  });

  props.onReady?.({ focus, insertText, closeSuggestions });

  function onSubmitKey() {
    if (untracked(suggestionsVisible)) {
      if (suggestionItems().length) applySuggestion();
      return;
    }
    if (props.submitOnEnter === false) return;
    props.onSubmit?.();
  }

  const addItems = () => [
    { id: "chat-composer-upload-files", label: props.uploadLabel || "", icon: "PhPaperclip" as IconName, onSelect: () => props.onUpload?.() },
    { id: "chat-composer-add-workspace", label: props.attachLabel || "", icon: "PhCube" as IconName, onSelect: () => props.onAttach?.() },
  ];

  const addTrigger = (): JSX.Element => (
    <View
      class={`min-h-8 flex-row items-center gap-1.5 rounded-(--radius) px-2 hover:bg-hover ${props.attachActive ? "bg-selection" : ""}`}
      accessibilityLabel={props.addLabel}
      testID="chat-composer-add"
    >
      <Icon name="PhPlus" size={16} color={props.attachActive ? "blue" : "subtle"} />
      <Text class="text-sm text-subtle">{props.addLabel}</Text>
    </View>
  );

  return (
    <View class={`gap-1.5 ${props.landing ? "w-full" : ""}`} testID={props.testID}>
      <View
        class="gap-2 rounded-(--radius) border border-line bg-field px-2 py-2 shadow-sm"
        onPress={() => focus({ preserveSelection: true })}
      >
        <If when={suggestionsVisible()}>
          <View role="listbox" accessibilityLabel={suggestionTitle()} class="gap-0.5 border-b border-line-faint pb-1.5" testID="chat-composer-suggestions">
            <Text class="px-2 font-mono text-xs uppercase text-muted-foreground">{suggestionTitle()}</Text>
            <Each of={suggestionItems()} key={(item) => item.key}>
              {(item, index) => (
                <BaseButton
                  role="option"
                  selected={index() === activeIndex()}
                  onPress={() => applySuggestion(item())}
                  accessibilityLabel={item().title}
                  class="flex-row items-baseline gap-2 rounded-(--radius) px-2 py-1 hover:bg-hover selected:bg-selection"
                >
                  <Text class="font-mono text-sm text-foreground">{item().title}</Text>
                  <If when={item().description}>
                    <Text class="flex-1 text-xs text-muted-foreground line-clamp-1">{item().description}</Text>
                  </If>
                </BaseButton>
              )}
            </Each>
            <If when={!suggestionItems().length}>
              <Text class="px-2 py-1 text-xs text-muted-foreground">{suggestionEmpty()}</Text>
            </If>
          </View>
        </If>
        <If when={(props.fileItems ?? []).length}>
          <View class="flex-row flex-wrap gap-1.5" accessibilityLabel={fileLabels().files} testID="chat-composer-files">
            <Each of={props.fileItems ?? []} key={(item) => item.id}>
              {(item) => (
                <View
                  class={`flex-row items-center gap-1 rounded-(--radius) border px-1.5 py-1 ${item().status === "failed" ? "border-danger" : "border-line-faint"} bg-card`}
                >
                  <BaseButton
                    disabled={item().status !== "ready"}
                    onPress={() => item().status === "ready" && props.onPreviewFile?.(item())}
                    accessibilityLabel={`${fileLabels().preview}: ${item().name}`}
                    tooltip={
                      <Text class="text-xs">
                        {item().status === "ready" ? fileLabels().preview : item().status === "uploading" ? fileLabels().uploading : item().error || fileLabels().failed}
                      </Text>
                    }
                    class="flex-row items-center gap-1.5"
                  >
                    <Icon name="PhPaperclip" size={13} color={item().status === "failed" ? "danger" : "subtle"} />
                    <View class="gap-px">
                      <Text class="max-w-48 text-xs text-foreground line-clamp-1">{item().name}</Text>
                      <If when={item().status === "uploading" || item().status === "failed"}>
                        <Text class={`max-w-60 text-xs ${item().status === "failed" ? "text-danger" : "text-muted-foreground"}`}>
                          {item().status === "uploading" ? fileLabels().uploading : item().error || fileLabels().failed}
                        </Text>
                      </If>
                    </View>
                  </BaseButton>
                  <If when={item().status === "failed" && item().sourceFile}>
                    <Button
                      variant="plain"
                      size="xxs"
                      label={fileLabels().retry}
                      disabled={props.disabled || props.attachDisabled}
                      onPress={() => props.onRetryFile?.(item())}
                    />
                  </If>
                  <Button
                    variant="plain"
                    size="xxs"
                    iconOnly
                    icon="PhXCircle"
                    title={`${fileLabels().remove}: ${item().name}`}
                    disabled={props.disabled}
                    onPress={() => props.onRemoveFile?.(item())}
                  />
                </View>
              )}
            </Each>
          </View>
        </If>
        <If when={voiceActive()}>
          <View role="text" class="flex-row items-center gap-2 rounded-(--radius) bg-paper px-2 py-1" testID="chat-composer-voice-strip">
            <View class={`size-2 rounded-full ${props.voiceState === "recording" ? "bg-danger" : "bg-status-pending"}`} />
            <Text class="font-mono text-xs text-subtle">{voiceElapsedText()}</Text>
            <Text class={`flex-1 text-sm ${props.voicePreview ? "text-foreground" : "text-muted-foreground"} line-clamp-2`}>
              {voiceStatusText()}
            </Text>
            <If when={props.voicePreviewEnabled !== null && props.voicePreviewEnabled !== undefined && props.voiceState === "recording"}>
              <Button
                variant="plain"
                size="xxs"
                iconOnly
                icon={props.voicePreviewEnabled ? "PhEye" : "PhEyeSlash"}
                title={props.voicePreviewEnabled ? voiceLabels().previewOff : voiceLabels().previewOn}
                selected={props.voicePreviewEnabled === true}
                onPress={() => props.onVoicePreviewToggle?.()}
              />
            </If>
            <If when={props.voiceState === "recording"}>
              <Button variant="plain" size="xxs" iconOnly icon="PhX" title={voiceLabels().discard} onPress={() => props.onVoiceCancel?.()} />
            </If>
          </View>
        </If>
        <View class="flex-row items-end gap-1.5">
          <If
            when={!props.attachDisabled && !props.uploading}
            else={
              <Button
                variant="plain"
                size="sm"
                icon="PhPlus"
                label={props.addLabel}
                disabled
                loading={props.uploading}
                testID="chat-composer-add"
              />
            }
          >
            <DropdownMenu trigger={addTrigger()} items={addItems()} placement="top" align="start" />
          </If>
          <Input
            ref={field}
            value={value()}
            multiline
            submitBehavior={submitBehavior()}
            returnKeyType={props.submitOnEnter === false ? "default" : "send"}
            placeholder={props.placeholder}
            accessibilityLabel={props.placeholder}
            readonly={props.disabled}
            autoCapitalize="sentences"
            testID="chat-composer-input"
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            onChange={({ value: next }) => {
              resetHistory();
              props.onChange(next);
              const range = untracked(selection);
              syncSuggestions(next, range.end > next.length || range.end === 0 ? next.length : range.end);
            }}
            onSelectionChange={({ start, end }) => {
              selection.set({ start, end });
              syncSuggestions(untracked(value), end);
            }}
            onSubmit={onSubmitKey}
            onContentSizeChange={({ size }) => contentHeight.set(Math.ceil(size.height))}
            onPaste={(event) => {
              if (props.disabled || props.attachDisabled) return;
              const files = namedImages(Array.isArray(event?.files) ? (event.files as File[]) : []);
              if (files.length) props.onAttachFiles?.(files);
            }}
            class="flex-1 px-1 py-1.5 text-sm text-foreground placeholder:text-placeholder"
            style={{ height: fieldHeight() + 12, lineHeight: LINE_HEIGHT }}
          />
          <View class="flex-row items-center gap-1">
            <If when={profiles().length > 1}>
              <Select
                items={profiles().map((item) => ({ value: item.value, title: item.title }))}
                value={String(selectedProfile()?.value ?? "")}
                searchable
                disabled={props.disabled}
                accessibilityLabel={profileTitle()}
                tooltip={<Text class="text-xs">{profileTitle()}</Text>}
                onChange={({ value: next }) => next !== null && props.onLLMProfileChange?.(String(next).trim())}
                testID="chat-composer-profile"
                placement="top"
                align="end"
                class="min-h-8 flex-row items-center gap-1 rounded-(--radius) px-2 hover:bg-hover disabled:opacity-45"
                popupClass="min-w-60 max-h-80 rounded-(--radius) border border-border bg-popover py-1 shadow-md"
                itemClass="px-3 py-1.5 hover:bg-hover focus:bg-hover selected:bg-selection"
                searchClass="mx-2 mb-1 rounded-(--radius) border border-input px-2 py-1 text-sm"
                searchPlaceholder="Filter"
                renderItem={(entry) => {
                  const profile = profiles()[entry.index];
                  return (
                    <View class="flex-row items-center gap-2">
                      <If when={profile?.image} else={<Icon name="PhCpu" size={14} color="subtle" />}>
                        <Image src={profile?.image ?? ""} style={{ width: 14, height: 14 }} />
                      </If>
                      <View class="flex-1">
                        <Text class="text-sm text-foreground">{entry.title}</Text>
                        <If when={profile?.subtitle}>
                          <Text class="font-mono text-xs text-muted-foreground">{profile?.subtitle ?? ""}</Text>
                        </If>
                      </View>
                    </View>
                  );
                }}
                trigger={
                  <View class="flex-row items-center gap-1">
                    <Text class="max-w-40 text-xs text-subtle line-clamp-1">{selectedProfile()?.title || props.llmProfileLabel || ""}</Text>
                    <Icon name="PhCaretDown" size={11} color="muted-foreground" />
                  </View>
                }
              />
            </If>
            <If when={props.voiceAvailable}>
              <Button
                variant="plain"
                size="sm"
                iconOnly
                icon={props.voiceState === "recording" ? "PhStop" : "PhMicrophone"}
                title={props.voiceLabel}
                selected={props.voiceState === "recording"}
                loading={props.voiceState === "transcribing"}
                disabled={props.disabled || props.voiceState === "transcribing"}
                onPress={() => props.onVoice?.()}
                testID="chat-composer-voice"
              />
            </If>
            <Button
              variant="primary"
              size="sm"
              iconOnly
              icon={props.stopMode ? "PhStop" : "PhPaperPlaneTilt"}
              title={props.sendLabel}
              loading={props.sending}
              disabled={props.sendDisabled}
              onPress={() => (props.stopMode ? props.onStop?.() : props.onSubmit?.())}
              testID="chat-composer-send"
            />
          </View>
        </View>
      </View>
      <If when={props.footerText}>
        <Text class="text-center text-xs text-muted-foreground">{props.footerText}</Text>
      </If>
    </View>
  );
}
