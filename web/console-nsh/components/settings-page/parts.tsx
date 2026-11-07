// Small pieces of the Settings page (SettingsView.css): a field with its label and note, a toggle
// row, a row with a control at its right, a fold (the Vue page's <details>), and a dot.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Collapsible, Switch } from "nsh/base";
import { Icon } from "../ui";
import { useRevealRow } from "./reveal";

/** A labelled field: label above, the control, a note below (`.settings-field`). */
export function SettingField(props: { label: string; note?: string; children?: JSX.Element; right?: JSX.Element; testID?: string; class?: string }) {
  const reveal = useRevealRow(() => props.label);
  return (
    <View
      ref={reveal.ref}
      class={`gap-1.5 rounded-(--radius) ${reveal.marked() ? "bg-selection" : ""} ${props.class ?? ""}`}
      testID={props.testID}
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-xs font-medium text-subtle">{props.label}</Text>
        {props.right}
      </View>
      {props.children}
      <If when={props.note}>
        <Text class="text-xs text-muted-foreground">{props.note}</Text>
      </If>
    </View>
  );
}

/** A switch at the right of its title and note (`.settings-toggle-row`). */
export function SettingToggleRow(props: {
  title: string;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  leading?: JSX.Element;
  /** Buttons before the switch. */
  actions?: JSX.Element;
  /** Replaces the switch (a tool with no setting). */
  control?: JSX.Element;
  first?: boolean;
  testID?: string;
}) {
  const reveal = useRevealRow(() => props.title);
  return (
    <View
      ref={reveal.ref}
      class={`flex-row items-center gap-3 py-3 ${props.first ? "" : "border-t border-line-faint"} ${reveal.marked() ? "bg-selection" : ""}`}
      testID={props.testID}
    >
      {props.leading}
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <If when={props.note}>
          <Text class="text-xs text-muted-foreground">{props.note}</Text>
        </If>
      </View>
      <View class="flex-row items-center gap-1">
        {props.actions}
        <If
          when={props.control}
          else={
            <Switch
              checked={props.checked}
              disabled={props.disabled}
              onChange={({ checked }) => props.onChange?.(checked)}
              accessibilityLabel={props.title}
              testID={props.testID ? `${props.testID}-switch` : undefined}
              class="disabled:opacity-45"
              trackClass="w-8 h-4.5 rounded-full bg-line p-0.5 transition-colors checked:bg-blue"
              thumbClass="size-3.5 rounded-full bg-card transition-transform checked:translate-x-3.5"
            />
          }
        >
          {props.control}
        </If>
      </View>
    </View>
  );
}

/** A row of a list card: title and note at the left, a control at the right (`.settings-console-row`). */
export function SettingRow(props: { title: string; note?: string; status?: JSX.Element; children?: JSX.Element; first?: boolean; testID?: string }) {
  const reveal = useRevealRow(() => props.title);
  return (
    <View
      ref={reveal.ref}
      class={`flex-row flex-wrap items-center gap-3 py-3 ${props.first ? "" : "border-t border-line-faint"} ${reveal.marked() ? "bg-selection" : ""}`}
      testID={props.testID}
    >
      <View class="min-w-60 flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <If when={props.note}>
          <Text class="text-xs text-muted-foreground">{props.note}</Text>
        </If>
        {props.status}
      </View>
      {props.children}
    </View>
  );
}

/** Content folded under a summary line (the Vue page's <details>). Folded content keeps its drafts. */
export function Fold(props: {
  open: boolean;
  onToggle: () => void;
  title: string;
  note?: string;
  children?: JSX.Element;
  testID?: string;
  class?: string;
}) {
  return (
    <Collapsible open={props.open} content={<View class="gap-4 pt-3">{props.children}</View>} class={props.class}>
      <View
        role="button"
        accessibilityLabel={props.title}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        testID={props.testID}
        class="flex-row items-center gap-2 rounded-(--radius) py-1.5 hover:bg-hover"
      >
        <Icon name={props.open ? "PhCaretDown" : "PhCaretRight"} size={14} color="muted-foreground" />
        <View class="flex-1 gap-0.5">
          <Text class="text-sm font-medium text-foreground">{props.title}</Text>
          <If when={props.note}>
            <Text class="text-xs text-muted-foreground">{props.note}</Text>
          </If>
        </View>
      </View>
    </Collapsible>
  );
}

/** The small mark of unsaved changes (`.settings-channel-tile-dirty`). */
export function DirtyDot(props: { label: string; testID?: string }) {
  return (
    <View
      accessibilityLabel={props.label}
      testID={props.testID}
      class="size-2 rounded-full bg-warn"
    />
  );
}

/** A card of rows, as the Vue page's boxed AppSection. */
export function SettingsCard(props: {
  title?: string;
  meta?: string;
  actions?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
  class?: string;
}) {
  const reveal = useRevealRow(() => props.title);
  return (
    <View
      ref={reveal.ref}
      class={`gap-3 rounded-(--radius) border bg-card p-4 ${reveal.marked() ? "border-blue" : "border-line-faint"} ${props.class ?? ""}`}
      testID={props.testID}
    >
      <If when={props.title || props.actions}>
        <View class="flex-row items-start justify-between gap-3">
          <View class="flex-1 gap-0.5">
            <If when={props.title}>
              <Text class="text-base font-semibold text-foreground" role="header">
                {props.title}
              </Text>
            </If>
            <If when={props.meta}>
              <Text class="text-xs text-muted-foreground">{props.meta}</Text>
            </If>
          </View>
          {props.actions}
        </View>
      </If>
      {props.children}
    </View>
  );
}
