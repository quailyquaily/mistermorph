// The parts Skills, the Skill Store, Memories and Contacts share: the workspace index column (the
// Vue console's workspace-sidebar-section), its rows, the boxed detail card with its property list,
// the inline notice (AppNotice), the phone bar with its back button, and the search field.
import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { Button as BaseButton, Switch } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { Button, Icon, TextField, type IconName } from "../ui";

/** translate with its variables typed (the JS default `vars = null` reads as `null` only). */
export const t = translate as unknown as (key: string, vars?: Record<string, unknown>) => string;

/** An inline notice in the page (the Vue console's AppNotice): an error, a warning or a note. */
export function InlineNotice(props: { type?: "error" | "warning" | "info"; text: string; testID?: string; class?: string }) {
  const tone = () => props.type ?? "error";
  return (
    <View
      testID={props.testID}
      role="alert"
      class={`flex-row items-start gap-2 rounded-(--radius) border-l-2 bg-card px-3 py-2 ${
        tone() === "error" ? "border-danger" : tone() === "warning" ? "border-warn" : "border-blue"
      } ${props.class ?? ""}`}
    >
      <Icon
        name={tone() === "error" ? "PhWarningCircle" : tone() === "warning" ? "PhWarning" : "PhInfo"}
        size={16}
        color={tone() === "error" ? "danger" : tone() === "warning" ? "warn-dark" : "blue"}
      />
      <View class="flex-1" selectable>
        <Text class="text-sm text-foreground">{props.text}</Text>
      </View>
    </View>
  );
}

/** A quiet line of text: an empty list, a hint. */
export function Note(props: { text: string; class?: string; testID?: string }) {
  return (
    <Text testID={props.testID} class={`text-sm text-muted-foreground ${props.class ?? ""}`}>
      {props.text}
    </Text>
  );
}

/** The search field at the top of an index or a grid. */
export function SearchField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onSubmit?: () => void;
  testID?: string;
  class?: string;
}) {
  return (
    <TextField
      value={props.value}
      onChange={(value) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      placeholder={props.placeholder}
      accessibilityLabel={props.placeholder}
      leadingIcon="PhMagnifyingGlass"
      testID={props.testID}
      class={props.class}
    />
  );
}

/**
 * The index column of a workspace page: its heading with actions, then a body that scrolls. On a
 * phone it fills the page (`fill`).
 */
export function IndexColumn(props: {
  title: string;
  actions?: JSX.Element;
  /** Above the scrolling body (a search field). */
  top?: JSX.Element;
  fill?: boolean;
  label?: string;
  testID?: string;
  children?: JSX.Element;
  /** Draw the body yourself (a List that scrolls on its own). */
  scroll?: boolean;
}) {
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.label ?? props.title}
      class={`${props.fill ? "flex-1" : "w-72 border-r border-line-faint"} bg-sidebar`}
    >
      <View class="min-h-12 flex-row items-center justify-between gap-2 px-4 py-2">
        <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground" role="header">
          {props.title}
        </Text>
        <If when={props.actions}>
          <View class="flex-row items-center gap-0.5">{props.actions}</View>
        </If>
      </View>
      <If when={props.top}>
        <View class="px-3 pb-2">{props.top}</View>
      </If>
      <If when={props.scroll !== false} else={<View class="flex-1">{props.children}</View>}>
        <Scroll class="flex-1" contentClass="gap-0.5 px-2 pb-4">
          {props.children}
        </Scroll>
      </If>
    </View>
  );
}

/** A divider label between groups of an index. */
export function IndexDivider(props: { label: string }) {
  return (
    <View class="px-2 pb-1 pt-3">
      <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.label}</Text>
    </View>
  );
}

/** One row of an index: a title and a meta line, something before and after. */
export function IndexRow(props: {
  title: string;
  meta?: string;
  active?: boolean;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  icon?: IconName;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <BaseButton
      testID={props.testID}
      onPress={() => props.onPress()}
      selected={props.active === true}
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      class={`flex-row items-center gap-2.5 rounded-(--radius) px-2.5 py-2 hover:bg-hover active:bg-selection ${
        props.active ? "bg-selection" : ""
      }`}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} size={16} color={props.active ? "blue" : "subtle"} />
      </If>
      {props.leading}
      <View class="flex-1 gap-0.5">
        <Text class={`text-sm ${props.active ? "font-medium text-ink" : "text-foreground"} line-clamp-1`}>{props.title}</Text>
        <If when={props.meta}>
          <Text class="text-xs text-muted-foreground line-clamp-1">{props.meta}</Text>
        </If>
      </View>
      {props.trailing}
    </BaseButton>
  );
}

/** A loading placeholder of `count` blocks. */
export function Blocks(props: { count?: number; height?: number; class?: string; label?: string }) {
  const rows = () => Array.from({ length: Math.max(1, props.count ?? 3) }, (_, index) => index);
  return (
    <View class={`gap-2 ${props.class ?? ""}`} accessibilityLabel={props.label}>
      <Each of={rows()}>{() => <View class="rounded-(--radius) bg-muted" style={{ height: props.height ?? 52 }} />}</Each>
    </View>
  );
}

/** The boxed card a page shows its picked item in (AppSection variant="boxed"). */
export function DetailCard(props: {
  title: string;
  meta?: JSX.Element;
  actions?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
  class?: string;
}) {
  return (
    <View testID={props.testID} class={`gap-4 rounded-(--radius) border border-line-faint bg-card p-5 ${props.class ?? ""}`}>
      <View class="flex-row items-start justify-between gap-3">
        <View class="flex-1 gap-1">
          <View selectable>
            <Text class="text-lg font-semibold text-foreground" role="header">
              {props.title}
            </Text>
          </View>
          {props.meta}
        </View>
        <If when={props.actions}>
          <View class="flex-row items-center gap-1">{props.actions}</View>
        </If>
      </View>
      {props.children}
    </View>
  );
}

/** A label and its value (ui-property-list). */
export function PropertyRow(props: { label: string; children?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} class="flex-row items-start gap-3 border-t border-line-faint py-2">
      <Text class="w-28 pt-0.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.label}</Text>
      <View class="flex-1 gap-2">{props.children}</View>
    </View>
  );
}

/** A value of a property row, as text that can be selected. */
export function PropertyText(props: { text: string; mono?: boolean; class?: string }) {
  return (
    <View selectable>
      <Text class={`text-sm text-foreground ${props.mono ? "font-mono" : ""} ${props.class ?? ""}`}>{props.text}</Text>
    </View>
  );
}

/** A link inside a property: opens outside the app. */
export function LinkText(props: { text: string; onPress: () => void; testID?: string }) {
  return (
    <Text testID={props.testID} role="link" onPress={() => props.onPress()} class="text-sm text-blue underline">
      {props.text}
    </Text>
  );
}

/** The phone's page bar while one item is open: back, then its title. */
export function MobileBar(props: { title: string; backLabel: string; onBack?: () => void; actions?: JSX.Element }) {
  return (
    <View class="min-h-12 flex-row items-center gap-2 border-b border-line-faint px-3 py-2">
      <If when={props.onBack}>
        <Button
          variant="plain"
          size="xs"
          iconOnly
          icon="PhArrowLeft"
          title={props.backLabel}
          onPress={() => props.onBack?.()}
          testID="mobile-back"
        />
      </If>
      <Text class="flex-1 text-base font-semibold text-foreground line-clamp-1" role="header">
        {props.title}
      </Text>
      {props.actions}
    </View>
  );
}

/** A small mono heading inside a card. */
export function SubHeading(props: { text: string; right?: JSX.Element }) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.text}</Text>
      {props.right}
    </View>
  );
}

/** A switch with no visible label; `label` is what screen readers say (AppSwitch with aria-label). */
export function SwitchOnly(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.label}
      testID={props.testID}
      class="flex-row items-center disabled:opacity-45"
      trackClass="w-8 h-4.5 rounded-full bg-line p-0.5 transition-colors checked:bg-blue"
      thumbClass="size-3.5 rounded-full bg-card transition-transform checked:translate-x-3.5"
    />
  );
}
