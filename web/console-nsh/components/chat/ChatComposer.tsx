// The chat's message field (the Vue console's ChatComposer): a growing text field that sends on
// Enter (on desktops; Shift+Enter for a new line), `/` commands and `$` skills offered as you type
// (arrows, Enter or Tab, Escape), Up and Down through what you sent before, attached files with
// their upload state, the add menu (upload files, attach a workspace), the model picker, voice
// input, and Send that turns into Stop while a reply runs.
//
// Not ported: the coloured overlay that marked command and skill tokens inside the text (a native
// text field draws its own text; nothing can be laid exactly over it).
import type { InputRef, JSX } from "nsh";
import { batch, cleanup, createAnimatedValue, effect, Image, Keyboard, keyboardFrame, keymap, platform, signal, Text, token, untracked, View } from "nsh";
import { Button as BaseButton, Input, Select } from "nsh/base";
import { BorderBeam } from "../motion/BorderBeam";
import { motionMs } from "../motion/tokens";
import { PopoverPicker } from "../shared/PopoverPicker";
import { ICONS } from "../icons";
import {
  bottomSheetStyle,
  Button,
  BusyBeam,
  busyLook,
  CircleButton,
  circleButtonClass,
  DropdownMenu,
  Icon,
  Tip,
  TipButton,
  MENU_POPUP_STYLE,
  trackPopup,
  type CircleButtonVariant,
  type IconName,
} from "../ui";
import {
  buildComposerSuggestionItems,
  composerSuggestionInsertText,
  composerTriggerContext,
  replaceComposerSuggestionToken,
} from "../../lib/core/chat-composer-suggestions.js";
import { isMobile } from "../../lib/shell";
import { COMPOSER_RADIUS, composerFieldBox, composerFrameClass, composerRowClass } from "./composerField";
import { COMPOSER_INPUT_CLASS, ComposerFieldSlot, composerPlaceholderShown } from "./ComposerFieldSlot";
import { ComposerMeasure, INITIAL_MEASURES } from "./ComposerMeasure";
import { followComposerLayout, ONE_ROW, type ComposerLayout } from "./composerRows";
import { PROFILE_SHEET_MAX_HEIGHT, PROFILE_SHEET_PADDING } from "./composerSheets";
import { t } from "./i18n";
import { AttachSourceSheet, type AttachSource, type AttachSourceLabels } from "./AttachSourceSheet";
import { draftFilePillClass, fileIcon } from "./filePill";
import { draftFilePreviewable } from "./filePreview";

// Around the 38-point mic, for a 44-point touch target.
/** The gap between the composer's edge and a list beyond it (the profile picker's, the add menu's). */
const POPUP_GAP = 8;
/** The place of the controls that open those lists, in the frame in both layouts: 38pt tall, above
 *  the row's 8pt bottom padding and the frame's 1pt border. */
const CONTROL_SIZE = 38;
const CONTROL_FROM_BOTTOM = CONTROL_SIZE + 8 + 1;
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
  /**
   * Touch screens: Upload files asks where from first (AttachSourceSheet: Gallery or File), then
   * this opens that picker. Without it, or on a desktop, Upload files is `onUpload` at once.
   */
  onUploadFrom?: (source: AttachSource) => void;
  uploadSourceLabels?: AttachSourceLabels;
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

type TokenName = Parameters<typeof token>[0];

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

/**
 * The voice button's look in each voice state: idle, the primary circle button (Send's, ready to
 * send) with a white glyph; recording, the danger circle (red) with the glyph still white;
 * transcribing, the busy primary button (Send's while sending: a soft box, an ink glyph, the beam).
 * `look` names it for the glyph's testID.
 */
export function voiceButtonLook(state: "idle" | "recording" | "transcribing" | undefined): {
  look: "primary" | "recording" | "busy";
  variant: CircleButtonVariant;
  tint: TokenName;
  busy: boolean;
} {
  if (state === "recording") return { look: "recording", variant: "danger", tint: "destructive-foreground", busy: false };
  if (state === "transcribing") return { look: "busy", variant: "plain", tint: busyLook("primary").text, busy: true };
  return { look: "primary", variant: "primary", tint: "primary-foreground", busy: false };
}

/** The voice/Send drum (VoiceOrSend): its chambers' spacing, its axis below the button's centre,
 * one chamber's turn, and the curve that overshoots a little and clicks back into place. */
export const DRUM_STEP = 60;
export const DRUM_RADIUS = 26;
const DRUM_TURN_MS = 240;
const DRUM_EASE: [number, number, number, number] = [0.34, 1.32, 0.64, 1];
/** The drum's turn sampled along the arc (a chamber's place is not linear in the turn). */
const DRUM_INPUT = [-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];

/**
 * Where a glyph on the drum sits, from the button's centre, along DRUM_INPUT: the chamber `offset`
 * steps from the mic's (the mic's 0, Send's -1), at angle (turn + offset) × DRUM_STEP from the top,
 * clockwise. Upright, so only its place moves.
 */
export function drumOffsets(offset: number, axis: "x" | "y") {
  return DRUM_INPUT.map((turn) => {
    const angle = ((turn + offset) * DRUM_STEP * Math.PI) / 180;
    const value = axis === "x" ? DRUM_RADIUS * Math.sin(angle) : DRUM_RADIUS * (1 - Math.cos(angle));
    return Math.round(value * 1000) / 1000;
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
  // A profile's mark, in the menu and on the picker: its model vendor's logo, else a chip.
  const profileGlyph = (profile: ComposerProfileItem | null | undefined) => (
    <If when={profile?.image} else={<Icon name="PhCpu" size={14} color="subtle" />}>
      <Image src={profile?.image ?? ""} accessibilityElementsHidden style={{ width: 14, height: 14 }} />
    </If>
  );
  const profileTitle = () => {
    const label = String(props.llmProfileLabel ?? "").trim();
    const chosen = String(selectedProfile()?.title ?? "").trim();
    return label && chosen ? `${label}: ${chosen}` : label || chosen;
  };
  // One row while the text is one line beside the controls; past that (or with a line break), the
  // field goes above them across the whole row at once. Decided from the text's height beside the
  // controls, which the layout does not change, so it never flips back on its own (composerRows.ts).
  const layout = signal<ComposerLayout>(ONE_ROW);
  const multiRow = () => layout().rows === "two";
  // On one row the field is as tall as the controls with its line on their centre line
  // (composerField.ts); above them it is as tall as its text across the row.
  const fieldBox = () => composerFieldBox(multiRow(), layout().height);
  // One line, cut with an ellipsis, over the field's first line (ComposerFieldSlot.tsx).
  const placeholderShown = () => composerPlaceholderShown(props.placeholder, value(), composing());
  // Rows change in one snap, heights above the controls ease; the history above moves with them.
  followComposerLayout(layout, value, measures);
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

  // The focus goes to the field a moment after it is asked for. A composer gone by then (its topic
  // or its pane left) or turned read-only (a send under way) raises no keyboard.
  let gone = false;
  cleanup(() => {
    gone = true;
  });
  function focus(options: { preserveSelection?: boolean } = {}) {
    if (props.disabled) return;
    setTimeout(() => {
      if (gone || props.disabled) return;
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
  // popups open at their trigger; the field takes the focus back after them too.
  const touchScreen = () => !platform.desktop;
  let refocusAfterSheet = false;
  function sheetOpened() {
    // On every screen: a list with a search field (the profile picker) takes the focus as it opens
    // (nsh 0.5), and the field gets it back once the list is gone.
    refocusAfterSheet = untracked(focused);
    if (touchScreen()) Keyboard.dismiss();
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
  // The profile picker's and the add menu's lists open beyond the whole composer (as a dock's panel
  // over the dock): what they clear above and below their button is the frame around it
  // (PopoverPicker). Both sit at the frame's foot the same way, in both layouts.
  const frameHeight = signal(0);
  const composerClearance = () => ({
    top: Math.max(0, frameHeight() - CONTROL_FROM_BOTTOM),
    bottom: CONTROL_FROM_BOTTOM - CONTROL_SIZE,
  });
  const profileSheetStyle = () =>
    bottomSheetStyle(PROFILE_SHEET_PADDING, {
      contentMax: PROFILE_SHEET_MAX_HEIGHT,
      keyboard: touchScreen() && profileSheetLifts() ? keyboardFrame().height : 0,
      style: MENU_POPUP_STYLE,
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

  // Upload files on a touch screen asks Gallery or File first (the system's photo or document
  // picker); the keyboard stays down through it, as for the pickers. Cancelled, nothing changes.
  const sourceSheetOpen = signal(false);
  function upload() {
    if (touchScreen() && props.onUploadFrom) sourceSheetOpen.set(true);
    else props.onUpload?.();
  }
  function chooseSource(source: AttachSource) {
    sourceSheetOpen.set(false);
    props.onUploadFrom?.(source);
  }

  const addItems = () => [
    { id: "chat-composer-upload-files", label: props.uploadLabel || "", icon: "PhPaperclip" as IconName, onSelect: () => leaveFromSheet(upload) },
    { id: "chat-composer-add-workspace", label: props.attachLabel || "", icon: "PhCube" as IconName, onSelect: () => leaveFromSheet(() => props.onAttach?.()) },
  ];

  // The add button: a bare "+" in a 38pt circle (circleButtonClass, the menu's trigger draws its
  // own box), its label for screen readers only (the Vue console's `.chat-composer-add-menu`); the
  // line-soft fill while the menu is open or a workspace is attached. `named`: it carries the label
  // and testID itself (the touch screens' menu); PopoverPicker's trigger carries them on desktops.
  const addOpen = signal(false);
  const addTrigger = (named = true): JSX.Element => (
    <View
      class={`${circleButtonClass()} aria-expanded:bg-segment ${props.attachActive || addOpen() ? "bg-segment" : ""}`}
      accessibilityLabel={named ? props.addLabel : undefined}
      testID={named ? "chat-composer-add" : undefined}
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
          class={`${circleButtonClass()} ${props.uploading ? "" : "opacity-45"}`}
          accessibilityLabel={props.addLabel}
          accessibilityState={{ busy: !!props.uploading }}
          testID="chat-composer-add"
        >
          <Icon name="PhPlus" size={14} color={props.uploading ? busyLook("plain").text : "subtle"} />
          <BusyBeam busy={!!props.uploading} variant="plain" short radius={19} testID="chat-composer-add-beam" />
        </View>
      }
    >
      {/* Desktops: the shared popover beyond the composer (as the profile picker's), its tail to
          the button; touch screens: the menu's sheet at the bottom. */}
      <If
        when={!touchScreen()}
        else={
          <DropdownMenu
            trigger={addTrigger()}
            items={addItems()}
            placement="top"
            align="start"
            onOpenChange={(open) => (open ? sheetOpened() : sheetClosed())}
          />
        }
      >
        <PopoverPicker
          items={addItems().map((item) => ({ value: item.id, title: item.label, icon: <Icon name={item.icon} size={16} color="subtle" /> }))}
          onChange={(id) => addItems().find((item) => item.id === id)?.onSelect()}
          trigger={() => addTrigger(false)}
          accessibilityLabel={props.addLabel ?? ""}
          placement="top"
          align="start"
          clearance={composerClearance()}
          gap={POPUP_GAP}
          widthClass="w-60"
          open={addOpen()}
          onOpenChange={(open) => {
            addOpen.set(open);
            if (open) sheetOpened();
            else sheetClosed();
          }}
          testID="chat-composer-add"
        />
      </If>
    </If>
  );

  // Send, a circle button through three states by its look rather than by swapping parts (the Vue
  // console's `.chat-composer-send`): nothing to send, a hairline ring with a muted plane nudged down-left;
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
    <CircleButton
      onPress={send}
      disabled={props.stopMode ? false : props.sendDisabled || sendBusy()}
      title={props.sendLabel ?? ""}
      testID="chat-composer-send"
      variant={sendBusy() ? "plain" : sendEmpty() ? "outlined" : "primary"}
      class={`${sendBusy() ? `border ${busyLook("primary").box}` : ""} ${
        !sendEmpty() && props.sendDisabled && !props.stopMode && !sendBusy() ? "opacity-45" : ""
      }`}
    >
      {/* The glyphs; while the drum turns (VoiceOrSend) it carries them instead. */}
      <View class="absolute inset-0 items-center justify-center" style={{ opacity: drumTurning() ? 0 : 1 }}>
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
      </View>
        <BusyBeam busy={sendBusy()} short radius={19} testID="chat-composer-send-beam" />
    </CircleButton>
  );

  // The mic, the primary circle button Send is once there is something to send (a 38-point circle
  // of ink, a white 14-point glyph) whose presses count 3 points around it: a 44-point target for a
  // finger. While it records it turns red, its glyph still white (voiceButtonLook), and is selected
  // for screen readers (pressing it still stops); while the recording is transcribed it is the busy
  // primary button Send is while sending (BusyBeam, busyLook). The glyph's testID names its look
  // and tint, for tests (no headless image query).
  const voiceLook = () => voiceButtonLook(props.voiceState);
  const voiceControl = () => (
    <CircleButton
      onPress={() => props.onVoice?.()}
      disabled={props.disabled || props.voiceState === "transcribing"}
      selected={props.voiceState === "recording"}
      title={props.voiceLabel ?? ""}
      hitSlop={VOICE_HIT_SLOP}
      testID="chat-composer-voice"
      variant={voiceLook().variant}
      class={voiceLook().busy ? `border ${busyLook("primary").box}` : "disabled:opacity-45"}
    >
      <View style={{ opacity: drumTurning() ? 0 : 1 }}>
        <Icon
          name="PhMicrophone"
          size={14}
          color={voiceLook().tint}
          testID={`chat-composer-voice-icon.PhMicrophone.${voiceLook().look}.${voiceLook().tint}`}
        />
      </View>
      <BusyBeam busy={voiceLook().busy} short radius={19} testID="chat-composer-voice-beam" />
    </CircleButton>
  );

  // The profile picker's pill: the profile's mark, its name while the composer is empty on wide
  // windows (the mark alone at phone widths and once there is a draft, to leave the field room;
  // the label and tip still name the profile), and a caret.
  const profilePill = () => (
    <View
      class={`h-[38px] flex-row items-center gap-1.5 rounded-full px-3 transition-colors duration-[180ms] hover:bg-hover active:bg-press ${
        profileSheetOpen() ? "bg-hover" : ""
      }`}
    >
      <View testID={`chat-composer-profile-icon.${selectedProfile()?.image ? "image" : "PhCpu"}`}>{profileGlyph(selectedProfile())}</View>
      <If when={!isMobile() && value().trim() === ""}>
        <Text testID="chat-composer-profile-name" class="max-w-40 text-xs text-subtle line-clamp-1">
          {selectedProfile()?.title || props.llmProfileLabel || ""}
        </Text>
      </If>
      <Icon name="PhCaretDown" size={11} color="muted-foreground" />
    </View>
  );

  // Touch screens: nsh's Select, a bottom sheet over the keyboard's place.
  function ProfileSheet() {
    return (
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
        class="rounded-full disabled:opacity-45"
        popupClass="min-w-64 rounded-[16px] border border-line-faint bg-dialog p-2"
        popupStyle={profileSheetStyle()}
        itemClass="rounded-[10px] px-3 py-2 hover:bg-hover focus:bg-hover selected:bg-selection"
        searchClass="mx-1 mb-2 rounded-full border border-input px-3 py-1.5 text-sm"
        searchPlaceholder="Filter"
        renderItem={(entry) => profileRow(profiles()[entry.index], entry.title)}
        trigger={profilePill()}
      />
    );
  }

  /** A profile's row: its mark, its title, its model in mono under it. */
  const profileRow = (profile: ComposerProfileItem | undefined, title: string) => (
    <View class="flex-row items-center gap-2">
      {profileGlyph(profile)}
      <View class="flex-1">
        <Text class="text-sm text-foreground">{title}</Text>
        <If when={profile?.subtitle}>
          <Text class="font-mono text-xs text-muted-foreground">{profile?.subtitle ?? ""}</Text>
        </If>
      </View>
    </View>
  );

  // Desktops: a popover beyond the composer, as the add menu opens (nsh's Select lays its list over
  // or under the trigger, as the system's drop-down does, whatever `placement` says): it clears the
  // frame above the picker (below it where the room above is short), its tail to the pill.
  function ProfilePopover() {
    return (
      <PopoverPicker
        items={profiles().map((item) => ({
          value: String(item.value ?? ""),
          title: item.title,
          subtitle: item.subtitle,
          icon: profileGlyph(item),
        }))}
        value={String(selectedProfile()?.value ?? "")}
        onChange={(next) => props.onLLMProfileChange?.(next.trim())}
        trigger={() => profilePill()}
        accessibilityLabel={profileTitle()}
        label={String(props.llmProfileLabel ?? "").trim()}
        filterPlaceholder="Filter"
        disabled={props.disabled}
        placement="top"
        align="end"
        clearance={composerClearance()}
        gap={POPUP_GAP}
        open={profileSheetOpen()}
        onOpenChange={(open) => profileSheetOpenChange(open)}
        testID="chat-composer-profile"
      />
    );
  }

  // Voice and Send share the row's end: the mic while there is nothing to send (no text, no
  // files) or while it records or transcribes, Send once there is something to send and while a
  // task runs (it is Stop then). Both stay in place, one over the other; the hidden one takes no
  // presses and is hidden from screen readers. Without voice input it is always Send.
  //
  // Between the mic and Send the glyphs turn like a revolver's cylinder: chambers DRUM_STEP apart on
  // a drum whose axis lies DRUM_RADIUS below the button's centre, one chamber's turn a step with a
  // small overshoot, a click into place. Typing turns Send in from the left as the mic leaves to the
  // right; clearing the field turns it back. The circles stay where they are (both the primary
  // circle at rest; they cross-fade under the drum), the glyphs stay upright and are clipped to the
  // circle. A turn reversed half-way goes back from where it is. While the drum turns it carries
  // both glyphs and the buttons hide their own; at rest each button draws its own (its look:
  // recording, busy, disabled). To and from Stop there is no turn (the plane is not what shows): the
  // two cross-fade with a slight scale, as with reduced motion.
  const voiceShown = () =>
    !!props.voiceAvailable && !props.stopMode && (voiceActive() || (value().trim() === "" && !(props.fileItems ?? []).length));
  // 0: the mic's chamber at the top; 1: Send's.
  const drum = createAnimatedValue(untracked(voiceShown) ? 0 : 1);
  const drumTurning = signal(false);
  let drumRun = 0;
  let wasStop = untracked(() => !!props.stopMode);
  let wasVoice = untracked(voiceShown);
  effect(() => {
    const voice = voiceShown();
    const stop = !!props.stopMode;
    untracked(() => {
      const changed = voice !== wasVoice;
      const viaStop = stop || wasStop;
      wasVoice = voice;
      wasStop = stop;
      if (!changed) return;
      const run = ++drumRun;
      const duration = motionMs(DRUM_TURN_MS);
      if (viaStop || !props.voiceAvailable || duration === 0) {
        drum.set(voice ? 0 : 1);
        drumTurning.set(false);
        return;
      }
      drumTurning.set(true);
      void drum.timing(voice ? 0 : 1, { duration, easing: DRUM_EASE }).then(({ finished }) => {
        if (finished && run === drumRun) drumTurning.set(false);
      });
    });
  });
  const crossFade = (shown: boolean) => ({
    opacity: shown ? 1 : 0,
    // The drum turns the glyphs; the circles only cross-fade under it.
    scale: shown || drumTurning() ? 1 : 0.6,
    pointerEvents: shown ? ("auto" as const) : ("none" as const),
  });
  /** A glyph on the drum, in the chamber `offset` steps from the mic's (the mic's 0, Send's -1). */
  const chamber = (offset: number) => ({
    transform: [
      { translateX: drum.interpolate({ inputRange: DRUM_INPUT, outputRange: drumOffsets(offset, "x"), extrapolate: "extend" }) },
      { translateY: drum.interpolate({ inputRange: DRUM_INPUT, outputRange: drumOffsets(offset, "y"), extrapolate: "extend" }) },
    ],
  });
  function VoiceOrSend() {
    return (
      <View class="relative size-[38px]" testID="chat-composer-voice-send">
        <If when={props.voiceAvailable}>
          <View
            class="absolute inset-0 transition duration-[220ms]"
            style={crossFade(voiceShown())}
            accessibilityElementsHidden={!voiceShown() || undefined}
            importantForAccessibility={voiceShown() ? undefined : "no-hide-descendants"}
          >
            {voiceControl()}
          </View>
        </If>
        <View
          class="absolute inset-0 transition duration-[220ms]"
          style={crossFade(!voiceShown())}
          accessibilityElementsHidden={voiceShown() || undefined}
          importantForAccessibility={voiceShown() ? "no-hide-descendants" : undefined}
        >
          {sendControl()}
        </View>
        {/* The drum: both glyphs, over the circles, clipped to them; not pressable. */}
        <If when={drumTurning()}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            class="absolute inset-0 overflow-hidden rounded-full"
            style={{ pointerEvents: "none" }}
            testID="chat-composer-drum"
          >
            <View class="absolute inset-0 items-center justify-center" style={chamber(0)}>
              <Icon name="PhMicrophone" size={14} color={voiceLook().tint} />
            </View>
            <View class="absolute inset-0 items-center justify-center" style={chamber(-1)}>
              <Image src={ICONS.PhPaperPlaneTilt} accessibilityElementsHidden style={{ width: 14, height: 14, tintColor: token("primary-foreground") as string }} />
            </View>
          </View>
        </If>
      </View>
    );
  }

  const actions = () => (
    <View class="shrink-0 flex-row items-center gap-2" onLayout={({ bounds }) => actionsWidth.set(bounds.size.width)}>
            <If when={profiles().length > 1}>
              {/* The profile picker: a 38pt pill as tall as the buttons beside it, the plain button's
                  hover and press, the whole of it the trigger. On desktops its list opens beyond the
                  composer (ProfilePopover); on touch screens it is a bottom sheet (ProfileSheet). */}
              <If when={!touchScreen()} else={<ProfileSheet />}>
                <ProfilePopover />
              </If>
            </If>
            {/* Voice and Send take turns in one place, the row's end (VoiceOrSend). */}
            <VoiceOrSend />
    </View>
  );

  return (
    <View class={`gap-2 ${props.landing ? "w-full" : "pb-2.5"}`} testID={props.testID}>
      <View
        class={composerFrameClass(isMobile())}
        onLayout={({ bounds }) => frameHeight.set(bounds.size.height)}
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
          <View class="flex-row flex-wrap items-start gap-1.5 px-2.5 pt-2.5" accessibilityLabel={fileLabels().files} testID="chat-composer-files">
            <Each of={props.fileItems ?? []} key={(item) => item.id}>
              {(item) => (
                // A pill (filePill.ts): the file's glyph and name preview it, while it can be (an image
                // on the device at once, any file once uploaded); Retry and Remove are buttons of
                // their own beside it, so neither is ever a press on the preview.
                <View class={draftFilePillClass(item().status === "failed")} testID={`chat-composer-file-${item().id}`}>
                  <TipButton
                    disabled={!draftFilePreviewable(item())}
                    onPress={() => draftFilePreviewable(item()) && props.onPreviewFile?.(item())}
                    accessibilityLabel={`${fileLabels().preview}: ${item().name}`}
                    tooltip={<Tip text={item().status === "uploading" ? fileLabels().uploading : item().status === "failed" ? item().error || fileLabels().failed : fileLabels().preview} />}
                    class="min-w-0 shrink flex-row items-center gap-1.5"
                    testID="chat-composer-file-preview"
                  >
                    <Icon
                      name={fileIcon(item().name, (item().sourceFile as { type?: string } | undefined)?.type)}
                      size={13}
                      color={item().status === "failed" ? "danger" : "subtle"}
                    />
                    <View class="min-w-0 shrink gap-px">
                      <Text class="max-w-48 text-xs text-foreground line-clamp-1">{item().name}</Text>
                      <If when={item().status === "uploading" || item().status === "failed"}>
                        <Text class={`max-w-60 text-xs ${item().status === "failed" ? "text-danger" : "text-muted-foreground"} line-clamp-2`}>
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
                      class="rounded-full"
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
                    class="rounded-full"
                    testID="chat-composer-file-remove"
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
            a row of the controls across the whole width, as the Vue composer's multi-row grid does
            (composerRows.ts). The field stays the same element, so it keeps its focus, caret and
            composition; ComposerMeasure measures the draft at both widths. Its slot draws the
            placeholder on one line (ComposerFieldSlot.tsx). */}
        <View class={composerRowClass(multiRow())}>
          <ComposerMeasure text={value()} actionsWidth={actionsWidth()} onMeasure={(next) => measures.set(next)} />
          <If when={!multiRow()}>{addControl()}</If>
          <ComposerFieldSlot
            rows={layout().rows}
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
          <BorderBeam length={96} radius={COMPOSER_RADIUS} testID="chat-composer-beam" />
        </If>
      </View>
      <AttachSourceSheet
        open={sourceSheetOpen()}
        onClose={() => sourceSheetOpen.set(false)}
        onChoose={chooseSource}
        labels={props.uploadSourceLabels}
      />
      <If when={props.footerText}>
        <Text class="px-3 text-center font-mono text-[11px] leading-[15.4px] tracking-[0.02em] text-muted-foreground">{props.footerText}</Text>
      </If>
    </View>
  );
}
