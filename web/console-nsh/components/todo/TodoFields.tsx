// The TODO editor's fields as the Vue page draws them (views/TodoView.css `.todo-control-prepend`,
// the ui-kit's .q-input and dropdown trigger): a 44pt field on a hairline with the field's name
// inside it, before the value ("Timezone  UTC+9 · Tokyo", "Workspace  /path"). ui.tsx's TextField
// puts its label above the field and has no slot before the text, so the TODO editor frames its own
// inputs and pickers here with the same metrics: white 92 %, the input hairline, 2pt corners, the
// blue focus border with its faint halo.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Input } from "nsh/base";

/** The field's frame; `focusWithinStyle` turns it blue while its input has the focus. */
export const FIELD_FRAME =
  "min-h-11 flex-row items-center gap-2 rounded-(--radius) border border-input bg-field pr-2";
/** The frame's left padding before a prepended name (the dropdown trigger's 0.8rem). */
export const FIELD_PAD = "pl-[12.8px]";
export const FIELD_FOCUS = { borderColor: "#426f9e9e", boxShadow: "0 0 0 1px rgba(66, 111, 158, 0.16)" };
export const FIELD_TRANSITION = {
  transitionProperty: "colors, box-shadow",
  transitionDuration: 200,
  transitionTimingFunction: "ease-in-out",
} as const;

/** The field's name inside it (`.todo-control-prepend`): text-1, 500 in a dropdown, 400 in an input. */
export function Prepend(props: { children: string; medium?: boolean }) {
  return (
    <Text class={`text-sm leading-[21px] tracking-[0.14px] text-subtle ${props.medium ? "font-medium" : "font-normal"}`} style={{ numberOfLines: 1 }}>
      {props.children}
    </Text>
  );
}

/** A note under a field (`.todo-field-note`): 12pt, text-2. */
export function FieldNote(props: { children: string }) {
  return <Text class="text-xs leading-[17.4px] text-muted-foreground">{props.children}</Text>;
}

/** A text input in the field frame, with its name before the value and buttons after it. */
export function TodoInput(props: {
  value: string;
  onChange: (value: string) => void;
  /** The name inside the field, before the value (Vue's #prepend). */
  prepend?: string;
  placeholder?: string;
  accessibilityLabel: string;
  disabled?: boolean;
  keyboardType?: "default" | "number-pad";
  /** The title field: 14pt semibold. */
  strong?: boolean;
  mono?: boolean;
  trailing?: JSX.Element;
  testID?: string;
  class?: string;
}) {
  return (
    <View
      class={`${FIELD_FRAME} ${props.prepend ? FIELD_PAD : ""} ${props.disabled ? "bg-transparent opacity-50" : ""} ${props.class ?? ""}`}
      focusWithinStyle={FIELD_FOCUS}
      style={FIELD_TRANSITION}
    >
      <If when={props.prepend}>
        <Prepend>{props.prepend!}</Prepend>
      </If>
      <Input
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        placeholder={props.placeholder}
        readonly={props.disabled}
        keyboardType={props.keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={props.accessibilityLabel}
        testID={props.testID}
        class={`flex-1 self-stretch py-1.5 ${props.prepend ? "pl-0.5" : "pl-3"} pr-1 text-sm text-foreground placeholder:text-placeholder caret-blue selection:bg-[#426f9e38] ${
          props.strong ? "font-semibold" : ""
        } ${props.mono ? "font-mono" : ""}`}
      />
      {props.trailing}
    </View>
  );
}
