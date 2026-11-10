// The chat's message field (the Vue console's ChatComposer): a growing text field that sends on
// Enter (on desktops; Shift+Enter for a new line), `/` commands and `$` skills offered as you type
// (arrows, Enter or Tab, Escape), Up and Down through what you sent before, attached files with
// their upload state, the add menu (upload files, attach a workspace), the model picker, voice
// input, and Send that turns into Stop while a reply runs.
//
// Not ported: the coloured overlay that marked command and skill tokens inside the text (a native
// text field draws its own text; nothing can be laid exactly over it).
import type { InputRef, JSX } from "nsh";
import { batch, cleanup, effect, Image, Keyboard, keyboardFrame, keymap, LayoutAnimation, platform, reduceMotion, signal, Text, token, untracked, View } from "nsh";
import { Button as BaseButton, Input, Select } from "nsh/base";
import { BorderBeam } from "../motion/BorderBeam";
import { ICONS } from "../icons";
import { bottomSheetStyle, Button, BusyBeam, busyLook, DropdownMenu, Icon, Tip, TipButton, trackPopup, type IconName } from "../ui";
import {
  buildComposerSuggestionItems,
  composerSuggestionInsertText,
  composerTriggerContext,
  replaceComposerSuggestionToken,
} from "../../lib/core/chat-composer-suggestions.js";
import { isMobile } from "../../lib/shell";
import { composerFieldBox, composerFrameClass, composerRowClass } from "./composerField";
import { COMPOSER_INPUT_CLASS, ComposerFieldSlot, composerPlaceholderShown } from "./ComposerFieldSlot";
import { ComposerMeasure, INITIAL_MEASURES } from "./ComposerMeasure";
import { composerLayout, ONE_ROW, sameComposerLayout, type ComposerLayout } from "./composerRows";
import { PROFILE_SHEET_MAX_HEIGHT, PROFILE_SHEET_PADDING } from "./composerSheets";
import { t } from "./i18n";

// Around the 38-point mic, for a 44-point touch target.
const VOICE_HIT_SLOP = 3;

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
  /** Whether the field has the focus now (untracked). */
  focused: () => boolean;
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
  /** `keyboardDismissed`: Send lowered the touch keyboard, and the field should stay unfocused. */
  onSubmit?: (options?: { keyboardDismissed?: boolean }) => void;
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
  // An input method's composition under way: its text is not in the draft yet on every platform.
  const composing = signal(false);
  const suggestionContext = signal<any>(null);
  const suggestionIndex = signal(0);
  const historyIndex = signal(-1);
  const measures = signal(INITIAL_MEASURES);
  const actionsWidth = signal(0);
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
  // One row while the text is one line beside the controls; above them, as wide as it was beside
  // them until it is more than a line at the full width too. Decided from the text's height at both
  // widths, which the layout does not change, so it never flips back on its own (composerRows.ts).
  const layout = signal<ComposerLayout>(ONE_ROW);
  const multiRow = () => layout().rows !== "one";
  // On one row the field is as tall as the controls with its line on their centre line
  // (composerField.ts); above them it is as tall as its text.
  const fieldBox = () => composerFieldBox(multiRow(), layout().height);
  const fieldWidth = () => {
    const width = measures().oneRowWidth;
    return layout().rows === "narrow" && width > 0 ? { width } : {};
  };
  // One line, cut with an ellipsis, over the field's first line (ComposerFieldSlot.tsx).
  const placeholderShown = () => composerPlaceholderShown(props.placeholder, value(), composing());
  // The rows and the height change together, and ease into place (the Vue composer's height
  // transition) rather than snapping; the history above makes room in the same motion.
  effect(() => {
    const next = composerLayout(value(), measures());
    untracked(() => {
      if (sameComposerLayout(layout(), next)) return;
      if (!reduceMotion()) LayoutAnimation.configureNext({ duration: 180, update: { type: "easeInEaseOut" } });
      layout.set(next);
    });
  });
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

  // The suggestion list is a popup while its keys are bound (below): Escape is its own then.
  trackPopup(() => focused() && !props.disabled && suggestionsVisible());
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

  props.onReady?.({ focus, focused: () => untracked(focused), insertText, closeSuggestions });

  // On touch screens the add menu and the model picker are sheets at the bottom of the screen, where
  // the software keyboard is (composerSheets.ts): the keyboard goes down as one opens, as phones do
  // for a sheet opened from a text field. The text and its caret stay; the field takes the focus
  // back when the sheet closes without leading elsewhere (cancelled, a model chosen), so typing goes
  // on. Upload and Attach go on to a picker or a dialog, and leave the keyboard down. The desktops'
  // popups open at their trigger and leave the field as it is.
  const touchScreen = () => !platform.desktop;
  let refocusAfterSheet = false;
  function sheetOpened() {
    if (!touchScreen()) return;
    refocusAfterSheet = untracked(focused);
    Keyboard.dismiss();
  }
  function sheetClosed() {
    if (!refocusAfterSheet) return;
    // After the item's onSelect, whichever order the menu reports them in.
    setTimeout(() => {
      if (!refocusAfterSheet) return;
      refocusAfterSheet = false;
      focus({ preserveSelection: true });
    }, 0);
  }
  function leaveFromSheet(action: () => void) {
    refocusAfterSheet = false;
    action();
  }

  // The model picker's search field raises the keyboard inside the sheet: the sheet then rises above
  // it. Only once the keyboard the opening lowered is down, so the sheet does not come in tall.
  const profileSheetOpen = signal(false);
  trackPopup(profileSheetOpen);
  const profileSheetLifts = signal(false);
  effect(() => {
    if (profileSheetOpen() && keyboardFrame().height === 0) untracked(() => profileSheetLifts.set(true));
  });
  // Above the navigation bar or gesture handle as every bottom sheet (bottomSheetStyle), and above
  // the keyboard instead once it lifts: the keyboard covers that bar, so the two are never added.
  const profileSheetStyle = () =>
    bottomSheetStyle(PROFILE_SHEET_PADDING, {
      contentMax: PROFILE_SHEET_MAX_HEIGHT,
      keyboard: touchScreen() && profileSheetLifts() ? keyboardFrame().height : 0,
    });
  function profileSheetOpenChange(open: boolean) {
    batch(() => {
      profileSheetOpen.set(open);
      profileSheetLifts.set(false);
    });
    if (open) sheetOpened();
    else sheetClosed();
  }

  function onSubmitKey() {
    if (untracked(suggestionsVisible)) {
      if (suggestionItems().length) applySuggestion();
      return;
    }
    if (props.submitOnEnter === false) return;
    props.onSubmit?.();
  }

  const addItems = () => [
    { id: "chat-composer-upload-files", label: props.uploadLabel || "", icon: "PhPaperclip" as IconName, onSelect: () => leaveFromSheet(() => props.onUpload?.()) },
    { id: "chat-composer-add-workspace", label: props.attachLabel || "", icon: "PhCube" as IconName, onSelect: () => leaveFromSheet(() => props.onAttach?.()) },
  ];

  // The add button: a bare "+" in a 38pt square, its label for screen readers only (the Vue
  // console's `.chat-composer-add-menu`); the line-soft fill while the menu is open or a workspace
  // is attached.
  const addTrigger = (): JSX.Element => (
    <View
      class={`size-[38px] items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft aria-expanded:bg-segment ${props.attachActive ? "bg-segment" : ""}`}
      accessibilityLabel={props.addLabel}
      testID="chat-composer-add"
    >
      <Icon name="PhPlus" size={14} color={props.attachActive ? "foreground" : "subtle"} />
    </View>
  );

  const addControl = () => (
    <If
      when={!props.attachDisabled && !props.uploading}
      else={
        // Uploading, it is a busy plain button (BusyBeam, busyLook).
        <View
          class={`relative size-[38px] items-center justify-center rounded-(--radius) ${props.uploading ? "" : "opacity-45"}`}
          accessibilityLabel={props.addLabel}
          accessibilityState={{ busy: !!props.uploading }}
          testID="chat-composer-add"
        >
          <Icon name="PhPlus" size={14} color={props.uploading ? busyLook("plain").text : "subtle"} />
          <BusyBeam busy={!!props.uploading} variant="plain" short testID="chat-composer-add-beam" />
        </View>
      }
    >
      <DropdownMenu
        trigger={addTrigger()}
        items={addItems()}
        placement="top"
        align="start"
        onOpenChange={(open) => (open ? sheetOpened() : sheetClosed())}
      />
    </If>
  );

  // Send, through three states by its look rather than by swapping parts (the Vue console's
  // `.chat-composer-send`): nothing to send, a hairline square with a muted plane nudged down-left;
  // ready, filled ink with the plane settled; running, the same fill with the plane crossfading into
  // the stop square. While a message is being sent it is a busy primary button (BusyBeam, busyLook).
  const sendBusy = () => !!props.sending && !props.stopMode;
  const sendEmpty = () => !props.stopMode && value().trim() === "" && !(props.fileItems ?? []).length;
  // On touch screens a tap on Send lowers the keyboard, as messaging apps do, so the reply is not
  // under it; the draft stays the parent's to clear or keep. The parent is told, so that it does not
  // give the field the focus back after the send, whatever the window's width (a tablet lays the
  // chat out as a desktop does). Stop, Enter and the desktops leave the keyboard as it is.
  function send() {
    if (props.stopMode) {
      props.onStop?.();
      return;
    }
    if (!touchScreen()) {
      props.onSubmit?.();
      return;
    }
    Keyboard.dismiss();
    props.onSubmit?.({ keyboardDismissed: true });
  }
  const sendControl = () => (
    <TipButton
      onPress={send}
      disabled={props.stopMode ? false : props.sendDisabled || sendBusy()}
      accessibilityLabel={props.sendLabel}
      tooltip={<Tip text={props.sendLabel ?? ""} />}
      testID="chat-composer-send"
      class={`relative size-[38px] items-center justify-center rounded-(--radius) border transition-colors duration-[180ms] ${
        sendBusy() ? busyLook("primary").box : sendEmpty() ? "border-line-soft bg-transparent" : "border-primary bg-primary hover:bg-ink"
      } ${!sendEmpty() && props.sendDisabled && !props.stopMode && !sendBusy() ? "opacity-45" : ""}`}
    >
        <Image
          src={ICONS.PhPaperPlaneTilt}
          accessibilityElementsHidden
          class="absolute transition duration-[260ms]"
          style={{
            width: 14,
            height: 14,
            tintColor: token(sendBusy() ? busyLook("primary").text : sendEmpty() ? "muted-foreground" : "primary-foreground") as string,
            opacity: props.stopMode ? 0 : 1,
            scale: props.stopMode ? 0.6 : 1,
            translate: sendEmpty() ? [-1.5, 1.5] : [0, 0],
          }}
        />
        <Image
          src={ICONS.PhStop}
          accessibilityElementsHidden
          class="absolute transition duration-[260ms]"
          style={{
            width: 14,
            height: 14,
            tintColor: token("primary-foreground") as string,
            opacity: props.stopMode ? 1 : 0,
            scale: props.stopMode ? 1 : 0.6,
          }}
        />
        <BusyBeam busy={sendBusy()} short testID="chat-composer-send-beam" />
    </TipButton>
  );

  // The mic, an icon button drawn as the add and send controls are (a 38-point square, a 14-point
  // glyph) whose presses count 3 points around it: a 44-point target for a finger. While it records
  // it is selected and shows Stop; while the recording is transcribed it is a busy plain button
  // (BusyBeam, busyLook): its disabled microphone with the beam round it.
  const voiceControl = () => (
    <TipButton
      onPress={() => props.onVoice?.()}
      disabled={props.disabled || props.voiceState === "transcribing"}
      selected={props.voiceState === "recording"}
      accessibilityLabel={props.voiceLabel}
      tooltip={<Tip text={props.voiceLabel ?? ""} />}
      hitSlop={VOICE_HIT_SLOP}
      testID="chat-composer-voice"
      class={`relative size-[38px] items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft selected:bg-selection ${
        props.voiceState === "transcribing" ? "" : "disabled:opacity-45"
      }`}
    >
      <Icon
        name={props.voiceState === "recording" ? "PhStop" : "PhMicrophone"}
        size={14}
        color={props.voiceState === "transcribing" ? busyLook("plain").text : props.voiceState === "recording" ? "ink" : "subtle"}
      />
      <BusyBeam busy={props.voiceState === "transcribing"} variant="plain" short testID="chat-composer-voice-beam" />
    </TipButton>
  );

  const actions = () => (
    <View class="shrink-0 flex-row items-center gap-2" onLayout={({ bounds }) => actionsWidth.set(bounds.size.width)}>
            <If when={profiles().length > 1}>
              <Select
                items={profiles().map((item) => ({ value: item.value, title: item.title }))}
                value={String(selectedProfile()?.value ?? "")}
                searchable
                disabled={props.disabled}
                accessibilityLabel={profileTitle()}
                tooltip={<Tip text={profileTitle()} />}
                onChange={({ value: next }) => next !== null && props.onLLMProfileChange?.(String(next).trim())}
                onOpenChange={({ open }) => profileSheetOpenChange(open)}
                testID="chat-composer-profile"
                placement="top"
                align="end"
                class="min-h-8 flex-row items-center gap-1 rounded-(--radius) px-2 hover:bg-hover disabled:opacity-45"
                popupClass="min-w-60 max-h-80 rounded-(--radius) border border-border bg-popover py-1 shadow-md"
                popupStyle={profileSheetStyle()}
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
            <If when={props.voiceAvailable}>{voiceControl()}</If>
      {sendControl()}
    </View>
  );

  return (
    <View class={`gap-2 ${props.landing ? "w-full" : "pb-2.5"}`} testID={props.testID}>
      <View
        class={composerFrameClass(isMobile())}
        onPress={() => focus({ preserveSelection: true })}
      >
        <If when={suggestionsVisible()}>
          <View role="listbox" accessibilityLabel={suggestionTitle()} class="gap-0.5 border-b border-line-faint p-1.5" testID="chat-composer-suggestions">
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
          <View class="flex-row flex-wrap gap-1.5 px-2.5 pt-2.5" accessibilityLabel={fileLabels().files} testID="chat-composer-files">
            <Each of={props.fileItems ?? []} key={(item) => item.id}>
              {(item) => (
                <View
                  class={`flex-row items-center gap-1 rounded-(--radius) border px-1.5 py-1 ${item().status === "failed" ? "border-danger" : "border-line-faint"} bg-card`}
                >
                  <TipButton
                    disabled={item().status !== "ready"}
                    onPress={() => item().status === "ready" && props.onPreviewFile?.(item())}
                    accessibilityLabel={`${fileLabels().preview}: ${item().name}`}
                    tooltip={<Tip text={item().status === "ready" ? fileLabels().preview : item().status === "uploading" ? fileLabels().uploading : item().error || fileLabels().failed} />}
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
                  </TipButton>
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
          <View role="text" class="mx-2.5 mt-2.5 flex-row items-center gap-2 rounded-(--radius) bg-paper px-2 py-1" testID="chat-composer-voice-strip">
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
        {/* One row (add, the field, actions) while the text is one line; longer, the field goes above
            a row of the controls, as the Vue composer's multi-row grid does, and takes the whole
            width once its text is more than a line there too (composerRows.ts). The field stays the
            same element, so it keeps its focus, caret and composition; ComposerMeasure measures the
            draft at both widths. Its slot draws the placeholder on one line (ComposerFieldSlot.tsx). */}
        <View class={composerRowClass(multiRow())}>
          <ComposerMeasure text={value()} actionsWidth={actionsWidth()} onMeasure={(next) => measures.set(next)} />
          <If when={!multiRow()}>{addControl()}</If>
          <ComposerFieldSlot
            rows={layout().rows}
            style={fieldWidth()}
            placeholder={props.placeholder}
            shown={placeholderShown()}
            lineTop={fieldBox().paddingTop}
            testID="chat-composer-placeholder"
          >
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
              onBlur={() => {
                focused.set(false);
                composing.set(false);
              }}
              onCompositionChange={({ composing: active, text }) => composing.set(active && text !== "")}
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
              onPaste={(event) => {
                if (props.disabled || props.attachDisabled) return;
                const files = namedImages(Array.isArray(event?.files) ? (event.files as File[]) : []);
                if (files.length) props.onAttachFiles?.(files);
              }}
              class={COMPOSER_INPUT_CLASS}
              style={fieldBox()}
            />
          </ComposerFieldSlot>
          <If when={!multiRow()}>{actions()}</If>
          <If when={multiRow()}>
            <View class="flex-row items-center justify-between">
              {addControl()}
              {actions()}
            </View>
          </If>
        </View>
        {/* While a task runs, the border beam travels the frame (design/ui-refresh.html §5). */}
        <If when={props.stopMode}>
          <BorderBeam length={96} testID="chat-composer-beam" />
        </If>
      </View>
      <If when={props.footerText}>
        <Text class="px-3 text-center font-mono text-[11px] leading-[15.4px] tracking-[0.02em] text-muted-foreground">{props.footerText}</Text>
      </If>
    </View>
  );
}
