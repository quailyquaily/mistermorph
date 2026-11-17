// Inserting text from a toolbar into an editor's text at the caret (MarkdownEditor's mention and
// conversation pickers). A toolbar press takes the focus from the field, so the field's last
// selection is remembered and the text goes in there: in place of the selected text, or at the
// caret, or at the end when the field has had no caret (a first use, another document).
//
// `insertIntoText` is the text alone; `createTextareaInsert` keeps the selection of a plain
// multiline `Input` (the Todo content's textarea) and puts the focus and caret back after the
// inserted text.
//
// The pickers are dialogs, and a dialog gives the focus back, once it has gone, to what had it as
// it opened: while one is there (going out too) the page behind it is inert, and a focus asked for
// there is lost (on the web, a focus asked for in the turn that opens it lands after it). So the
// textarea takes the focus, at its remembered selection, before a picker opens (`hold`; the dialog
// opens once the field has it), and the dialog hands it back.
import type { InputRef } from "nsh";

/** A selection in UTF-16 units (JS string offsets), as `Input` reports it; `end` may come before `start`. */
export interface TextRange {
  start: number;
  end: number;
}

export interface InsertOptions {
  /** Add a space on a side where the inserted text would touch other text. */
  spacing?: boolean;
}

/**
 * `value` with `text` in place of `range` (the end of the text without one), and the caret offset
 * just after what went in. Offsets past the text count as its end; a reversed range is the same
 * range. With `spacing`, a space goes before the text unless it starts the value or follows white
 * space, and after it unless it ends the value or white space follows.
 */
export function insertIntoText(
  value: string,
  range: TextRange | null | undefined,
  text: string,
  options: InsertOptions = {},
): { value: string; caret: number } {
  const current = String(value ?? "");
  const clamp = (offset: number) => (Number.isFinite(offset) ? Math.min(current.length, Math.max(0, Math.floor(offset))) : current.length);
  let start = range ? clamp(range.start) : current.length;
  let end = range ? clamp(range.end) : current.length;
  if (end < start) [start, end] = [end, start];
  const before = current.slice(0, start);
  const after = current.slice(end);
  const prefix = options.spacing === true && before && !/\s$/.test(before) ? " " : "";
  const suffix = options.spacing === true && after && !/^\s/.test(after) ? " " : "";
  const inserted = `${prefix}${text}${suffix}`;
  return { value: `${before}${inserted}${after}`, caret: start + inserted.length };
}

/** The part of an `InputRef` the textarea insertion uses (a fake one in tests). */
export type InsertField = Pick<InputRef, "focus" | "setSelection">;

export interface TextareaInsert {
  /** The field's `onChange`: the user's edit, whose caret the field reports next. */
  edited(value: string): void;
  /** The field's `onSelectionChange`. */
  selected(range: TextRange): void;
  /**
   * The value the field shows, read as it changes: a value that is not the field's own last edit
   * or insertion (another document, a reload, a discarded draft) drops the remembered selection,
   * and so does a new `document` key with the same text.
   */
  follow(value: string, document?: unknown): void;
  /** Puts `text` in place of the remembered selection; false (nothing changed) when locked or empty. */
  insert(text: string, options?: InsertOptions): boolean;
  /**
   * Focuses the field at the remembered selection (the end of the text without one), so a dialog
   * opened next returns the focus there as it goes. Nothing when locked.
   */
  hold(): void;
}

/**
 * Remembers a plain multiline `Input`'s selection for toolbar insertions. The app's value stays the
 * source of truth: an insertion reports the new text through `onChange`, then (a turn later, once
 * the field shows it) focuses the field with the caret after the inserted text.
 */
export function createTextareaInsert(options: {
  /** The value the field shows now. */
  value: () => string;
  onChange: (value: string) => void;
  /** Disabled or read-only: nothing goes in. */
  locked: () => boolean;
  field: () => InsertField | undefined;
  /** Runs the focus and caret step after the new value has rendered (default: the next task). */
  defer?: (run: () => void) => void;
}): TextareaInsert {
  const defer = options.defer ?? ((run: () => void) => void setTimeout(run, 0));
  let selection: TextRange | null = null;
  let lastValue: string = String(options.value() ?? "");
  let lastDocument: unknown = undefined;
  let documentSeen = false;

  return {
    edited(value) {
      lastValue = String(value ?? "");
    },
    selected(range) {
      selection = { start: range.start, end: range.end };
    },
    follow(value, document) {
      const text = String(value ?? "");
      const newDocument = documentSeen && document !== lastDocument;
      documentSeen = true;
      lastDocument = document;
      if (text !== lastValue || newDocument) {
        lastValue = text;
        selection = null;
      }
    },
    insert(raw, insertOptions = {}) {
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      if (!text || options.locked()) return false;
      const next = insertIntoText(String(options.value() ?? ""), selection, text, insertOptions);
      lastValue = next.value;
      selection = { start: next.caret, end: next.caret };
      options.onChange(next.value);
      defer(() => {
        if (options.locked()) return;
        const field = options.field();
        field?.focus();
        field?.setSelection(next.caret, next.caret);
      });
      return true;
    },
    hold() {
      const field = options.field();
      if (!field || options.locked()) return;
      const length = String(options.value() ?? "").length;
      const clamp = (offset: number) => Math.min(length, Math.max(0, offset));
      const start = selection ? clamp(Math.min(selection.start, selection.end)) : length;
      const end = selection ? clamp(Math.max(selection.start, selection.end)) : length;
      selection = { start, end };
      field.focus();
      field.setSelection(start, end);
    },
  };
}
