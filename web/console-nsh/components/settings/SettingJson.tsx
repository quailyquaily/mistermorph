// A setting given as raw JSON: a compact row (what it is at the left, an edit button at the right)
// and a dialog that edits the JSON. The row never shows the value.
//
// The dialog works on a draft of its own, copied from the setting each time it opens. Cancel, the
// backdrop and Escape drop it; Apply checks it (`validate`, valid JSON by default) and hands it to
// `onChange`, which is the form's draft, not a save: the form's own Save persists it as before. A
// draft that fails the check stays in the dialog with what is wrong.
import type { JSX } from "nsh";
import { batch, signal, Text, untracked, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { Button, TextField } from "../ui";
import { useRevealRow } from "../settings-page/reveal";
import { SettingDialog } from "./SettingDialog";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** What a JSON value must be, beyond valid JSON. */
export type JsonShape = "any" | "object" | "array";

/**
 * What is wrong with `text` as the JSON of the setting `name`, or "" when it is fine.
 * `empty: true` lets an empty text through (forms that read it as their default).
 */
export function jsonTextError(text: string, name: string, options: { shape?: JsonShape; empty?: boolean } = {}): string {
  const source = String(text ?? "");
  if (source.trim() === "") return options.empty ? "" : `${name} must be valid JSON: it is empty.`;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error: any) {
    const detail = String(error?.message || "").trim();
    return detail ? `${name} must be valid JSON: ${detail}` : `${name} must be valid JSON.`;
  }
  if (options.shape === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
    return `${name} must be a JSON object.`;
  }
  if (options.shape === "array" && !Array.isArray(value)) return `${name} must be a JSON array.`;
  return "";
}

export interface SettingJsonProps {
  /** The setting's JSON text, as the form keeps it. */
  value: string;
  /** Apply: the checked draft goes to the form's draft. */
  onChange?: (text: string) => void;
  /** The row's label. Leave it out when a label already stands above the row. */
  label?: string;
  /** What the setting is called in the edit button's name, the dialog's title and the errors (default: `label`). */
  name?: string;
  /** A description under the label. */
  note?: string;
  /** The note reads as a condition (italic): "Turn on X to change this." */
  noteItalic?: boolean;
  /** Beside the label (a restart tag). */
  labelRight?: JSX.Element;
  /** More under the note, at the left (where the value comes from). */
  below?: JSX.Element;
  /** Dimmed: it cannot be changed right now. */
  inactive?: boolean;
  /** Read-only: the dialog cannot be opened, and one that is open cannot apply. */
  disabled?: boolean;
  placeholder?: string;
  /** Visible lines of the dialog's field (12 by default). */
  rows?: number;
  /** What is wrong with a draft, or "" (default: it must be valid JSON, and not empty). */
  validate?: (text: string) => string;
  class?: string;
  testID?: string;
}

export function SettingJson(props: SettingJsonProps) {
  const name = () => props.name || props.label || "JSON";
  // The Settings page's search scrolls to a row by its label and marks it.
  const reveal = useRevealRow(() => props.label);
  const open = signal(false);
  const draft = signal("");
  const error = signal("");
  const id = (part: string) => (props.testID ? `${props.testID}-${part}` : undefined);

  const show = () => {
    if (props.disabled) return;
    // A new draft each time: what an earlier dialog left is gone.
    batch(() => {
      draft.set(String(props.value ?? ""));
      error.set("");
      open.set(true);
    });
  };

  // A setting that turns read-only under an open dialog (a save started) keeps the draft, but
  // cannot apply it. The error is not cleared by typing: it goes when a draft passes or the dialog
  // opens again, so a failed draft and its reason stay together until then.
  const apply = () => {
    if (props.disabled || !untracked(open)) return;
    const text = untracked(draft);
    const problem = props.validate ? props.validate(text) : jsonTextError(text, untracked(name));
    if (problem) {
      error.set(problem);
      return;
    }
    batch(() => {
      error.set("");
      open.set(false);
    });
    if (text !== String(props.value ?? "")) props.onChange?.(text);
  };

  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      testID={props.testID}
      class={`min-w-0 flex-row items-center justify-between gap-4 rounded-(--radius) py-1 ${props.inactive ? "opacity-55" : ""} ${
        reveal.ringed() ? "ring-2 ring-blue" : ""
      } ${props.class ?? ""}`}
    >
      <View class="min-w-0 flex-1 gap-1">
        <If when={props.label || props.labelRight}>
          <View class="flex-row items-center gap-3">
            <Text class="min-w-0 shrink text-sm font-medium leading-[18.9px] text-foreground">{props.label ?? ""}</Text>
            <If when={props.labelRight}>
              <View class="shrink-0">{props.labelRight}</View>
            </If>
          </View>
        </If>
        <If when={props.note}>
          <Text class={`text-xs leading-normal text-muted-foreground ${props.noteItalic ? "italic" : ""}`}>{props.note}</Text>
        </If>
        {props.below}
      </View>
      <Button
        variant="plain"
        size="xs"
        iconOnly
        icon="PhPencilSimple"
        title={t("settings_json_edit", { name: name() })}
        disabled={props.disabled}
        onPress={show}
        class="shrink-0"
        testID={id("edit")}
      />
      <SettingDialog
        open={open()}
        onOpenChange={(value) => open.set(value)}
        title={name()}
        saveLabel={t("action_apply")}
        saveDisabled={props.disabled}
        onSave={apply}
        testID={id("dialog")}
      >
        <View class="gap-2">
          <If when={props.note && !props.noteItalic}>
            <Text class="text-xs leading-normal text-muted-foreground">{props.note}</Text>
          </If>
          <TextField
            value={draft()}
            multiline
            rows={props.rows ?? 12}
            mono
            autoFocus
            placeholder={props.placeholder}
            disabled={props.disabled}
            accessibilityLabel={name()}
            onChange={(value) => draft.set(value)}
            // Escape in a focused field only leaves the field (nsh); here it drops the draft at
            // once, as it does anywhere else in the dialog.
            onKeyPress={(key) => {
              if (key === "Escape") open.set(false);
            }}
            testID={id("input")}
          />
          <If when={error()}>
            <Text class="text-sm text-danger" role="alert" testID={id("error")}>
              {error()}
            </Text>
          </If>
        </View>
      </SettingDialog>
    </View>
  );
}
