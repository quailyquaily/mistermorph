// Two hidden copies of the composer's field that lay the draft out at the widths the field can
// take: beside the controls (one row) and above them (two rows). Their widths come from the rows'
// own classes and the actions' measured width, never from the rows the composer shows, so what they
// report does not change when the layout does (composerRows.ts). They are inputs like the field, so
// the text wraps as it does there on every platform. Hidden (they keep their layout), they draw
// nothing and take no focus (not even the browser's Tab order), presses or screen readers.
//
// Placed as the first child of the composer's row view: absolute, so the row's flex layout and gap
// leave it out, and as wide as that row in both layouts.
import { View } from "nsh";
import { Input } from "nsh/base";
import { COMPOSER_CONTROL_SIZE, COMPOSER_FIELD_TEXT, COMPOSER_LINE_HEIGHT, composerRowClass } from "./composerField";
import type { ComposerMeasures } from "./composerRows";

export interface ComposerMeasured extends ComposerMeasures {
  /** The field's width beside the controls (the text's width in the `narrow` layout); 0 until laid out. */
  oneRowWidth: number;
}

export const INITIAL_MEASURES: ComposerMeasured = { oneRow: COMPOSER_LINE_HEIGHT, twoRows: COMPOSER_LINE_HEIGHT, oneRowWidth: 0 };

export function ComposerMeasure(props: { text: string; actionsWidth: number; onMeasure: (measures: ComposerMeasured) => void }) {
  let current = INITIAL_MEASURES;
  const update = (patch: Partial<ComposerMeasured>) => {
    const next = { ...current, ...patch };
    if (next.oneRow === current.oneRow && next.twoRows === current.twoRows && Math.abs(next.oneRowWidth - current.oneRowWidth) < 0.25) return;
    current = next;
    props.onMeasure(next);
  };
  const copy = (width: "flex-1" | "w-full", report: (height: number) => void, onWidth?: (width: number) => void) => (
    <Input
      value={props.text}
      multiline
      readonly
      focusable={false}
      caret={false}
      autoCorrect={false}
      onContentSizeChange={({ size }) => report(Math.ceil(size.height))}
      onLayout={onWidth ? ({ bounds }) => onWidth(bounds.size.width) : undefined}
      class={`${COMPOSER_FIELD_TEXT} ${width}`}
      style={{ height: COMPOSER_LINE_HEIGHT, paddingTop: 0, paddingBottom: 0, lineHeight: COMPOSER_LINE_HEIGHT }}
    />
  );
  return (
    <View
      class="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="chat-composer-measure"
    >
      {/* The one-row layout: the add button's place, the field, the actions' place. */}
      <View class={composerRowClass(false)}>
        <View class="shrink-0" style={{ width: COMPOSER_CONTROL_SIZE, height: COMPOSER_CONTROL_SIZE }} />
        {copy(
          "flex-1",
          (oneRow) => update({ oneRow }),
          (oneRowWidth) => update({ oneRowWidth }),
        )}
        <View class="shrink-0" style={{ width: props.actionsWidth, height: COMPOSER_CONTROL_SIZE }} />
      </View>
      {/* The two-row layout: the field across the row. */}
      <View class={composerRowClass(true)}>{copy("w-full", (twoRows) => update({ twoRows }))}</View>
    </View>
  );
}
