// The composer field's place in its row, and the placeholder drawn in it.
//
// The field is a multiline input, so that the draft wraps, and a multiline input wraps its own
// placeholder too: on a phone a long one ("Tell <a long agent name> anything", or the Chinese and
// Japanese ones, which are longer) took two or three lines in a box one line tall, which showed the
// words of its first line cut off with no ellipsis and let the field scroll to the others. So the
// field's own placeholder is drawn transparent, and the slot lays a one-line text cut with an
// ellipsis over the field's first line box instead, while the draft is empty and nothing is being
// composed. It is absolute in the slot, so it never sizes anything: the field's box and the rows
// still come from the draft alone (composerField.ts, ComposerMeasure.tsx), whatever the
// placeholder's length. It sits under the field and takes no presses, no focus and no screen
// reader's attention: the field gets them all.
//
// The field keeps its placeholder (and its accessibilityLabel) for screen readers: on the web nsh
// 0.4 puts accessibility props on the view around the textarea, so the textarea's accessible name
// is its placeholder alone. Being transparent, it still wraps where no one sees it: on the web a
// mouse wheel over an empty field can scroll those lines (as it scrolled the visible ones before).
import type { Bounds, JSX, TextLayoutLine } from "nsh";
import { Text, View } from "nsh";
import { COMPOSER_FIELD_TEXT, COMPOSER_LINE_HEIGHT } from "./composerField";
import type { ComposerRows } from "./composerRows";

/** The slot's place in the row: what the field's own classes were (beside the controls, or across
 *  the whole row above them). */
export function composerSlotClass(rows: ComposerRows): string {
  return rows === "one" ? "flex-1" : "w-full";
}

/** The field inside the slot: the field's text, as wide as the slot, its own placeholder unseen. */
export const COMPOSER_INPUT_CLASS = `${COMPOSER_FIELD_TEXT} w-full text-foreground placeholder:text-transparent`;

/** The placeholder's text: one line at most, cut with an ellipsis at its end, in the field's line. */
export const COMPOSER_PLACEHOLDER_STYLE = { numberOfLines: 1, textOverflow: "ellipsis", lineHeight: COMPOSER_LINE_HEIGHT } as const;

/** Whether the placeholder shows: an empty draft, no composition under way, a placeholder to show. */
export function composerPlaceholderShown(placeholder: string | null | undefined, value: string, composing: boolean): boolean {
  return !!placeholder && value === "" && !composing;
}

export function ComposerFieldSlot(props: {
  rows: ComposerRows;
  placeholder?: string | null;
  /** Whether the placeholder shows (composerPlaceholderShown). */
  shown: boolean;
  /** Where the field's first line box starts in it (its `paddingTop`). */
  lineTop: number;
  /** Probes for tests: the slot's frame in the row, the placeholder's in the slot and its lines. */
  onLayout?: (bounds: Bounds) => void;
  onPlaceholderLayout?: (bounds: Bounds) => void;
  onPlaceholderTextLayout?: (lines: TextLayoutLine[]) => void;
  testID?: string;
  children: JSX.Element;
}) {
  return (
    <View
      class={`relative ${composerSlotClass(props.rows)}`}
      onLayout={props.onLayout ? ({ bounds }) => props.onLayout?.(bounds) : undefined}
    >
      <If when={props.shown}>
        <View
          class="pointer-events-none absolute inset-x-0"
          style={{ top: props.lineTop, height: COMPOSER_LINE_HEIGHT }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onLayout={props.onPlaceholderLayout ? ({ bounds }) => props.onPlaceholderLayout?.(bounds) : undefined}
        >
          <Text
            class={`${COMPOSER_FIELD_TEXT} text-muted-foreground`}
            style={COMPOSER_PLACEHOLDER_STYLE}
            onTextLayout={props.onPlaceholderTextLayout ? ({ lines }) => props.onPlaceholderTextLayout?.(lines) : undefined}
            testID={props.testID}
          >
            {props.placeholder ?? ""}
          </Text>
        </View>
      </If>
      {props.children}
    </View>
  );
}
