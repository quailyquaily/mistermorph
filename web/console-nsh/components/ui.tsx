// The console's design system: its controls, drawn from nsh/base with the morph theme's tokens
// (theme.json). Pages build from these; a missing variant is added here, not restyled per page.
//
// The look follows the Vue console's ui-kit: square-ish corners (2px), hairlines, a dark blue
// primary, quiet plain buttons, mono caps for labels, and red only for what is destructive.
import type { InputRef, JSX } from "nsh";
import { cleanup, effect, Image, keymap, Scroll, signal, Text, token, untracked, View } from "nsh";
import {
  Button as BaseButton,
  Checkbox as BaseCheckbox,
  Dialog,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Progress,
  Select,
  Sheet,
  Switch,
  TextView,
  Tooltip,
} from "nsh/base";
import { dismissNotice, noticeState, pushNotice } from "../lib/core/notices.js";
import { ICONS, type IconName } from "./icons";

export type { IconName };

type Tone = "neutral" | "info" | "ok" | "warn" | "danger";
type TokenName = Parameters<typeof token>[0];

/* ---------- icons and marks ---------- */

/** A Phosphor icon (regular weight), tinted with a theme token. */
export function Icon(props: { name: IconName; size?: number; color?: TokenName; class?: string }) {
  return (
    <Image
      src={ICONS[props.name]}
      class={props.class}
      accessibilityElementsHidden
      style={{
        width: props.size ?? 16,
        height: props.size ?? 16,
        tintColor: token(props.color ?? "foreground") as string,
      }}
    />
  );
}

/** The console's square status mark: filled when on, hollow when off, orange when waiting. */
export function StatusMark(props: { state: "on" | "off" | "pending" | "error" | "unread"; class?: string }) {
  const cls = () => {
    switch (props.state) {
      case "on":
        return "bg-status-on border-status-on";
      case "unread":
        return "bg-status-on border-status-on";
      case "pending":
        return "bg-status-pending border-status-pending";
      case "error":
        return "bg-status-error border-status-error";
      default:
        return "border-status-off";
    }
  };
  return <View class={`size-2 border ${cls()} ${props.class ?? ""}`} />;
}

/** The one spinner. */
export function Spinner(props: { size?: number; class?: string }) {
  return (
    <View class={props.class}>
      <Progress
        indeterminate
        class="h-0.5 overflow-hidden bg-line-faint"
        style={{ width: props.size ?? 24 }}
        indicatorClass="h-0.5 bg-blue"
      />
    </View>
  );
}

/* ---------- text ---------- */

/** Mono caps label above a field or a group, as the Vue console's kicker. */
export function Kicker(props: { children?: JSX.Element; right?: JSX.Element; class?: string }) {
  return (
    <View class={`flex-row items-center justify-between gap-2 ${props.class ?? ""}`}>
      <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.children}</Text>
      {props.right}
    </View>
  );
}

/** A page's or a section's heading. */
export function Heading(props: { children?: JSX.Element; level?: 1 | 2 | 3; class?: string }) {
  const size = () => (props.level === 1 ? "text-xl" : props.level === 3 ? "text-base" : "text-lg");
  return <Text class={`${size()} font-semibold text-foreground ${props.class ?? ""}`}>{props.children}</Text>;
}

/** Secondary text: meta, hints, timestamps. */
export function Muted(props: { children?: JSX.Element; class?: string; numberOfLines?: number }) {
  return (
    <Text class={`text-xs text-muted-foreground ${props.class ?? ""}`} style={{ numberOfLines: props.numberOfLines ?? 0 }}>
      {props.children}
    </Text>
  );
}

/** Rendered Markdown (replies, documents), with the console's prose styles. */
export function Markdown(props: {
  source: string;
  class?: string;
  selectable?: boolean;
  onLinkPress?: (url: string) => void;
  streaming?: boolean;
}) {
  return (
    <TextView
      markdown={props.source}
      selectable={props.selectable ?? true}
      class={`text-sm text-foreground ${props.class ?? ""}`}
      onLinkPress={props.onLinkPress ? (event) => props.onLinkPress?.(event.url) : undefined}
      codeBlockScrollbar
      tableScrollbar
    />
  );
}

/* ---------- buttons ---------- */

export type ButtonVariant = "primary" | "outlined" | "plain" | "danger" | "highlight" | "ghost-danger";
export type ButtonSize = "md" | "sm" | "xs" | "xxs";

const BUTTON_VARIANTS: Record<ButtonVariant, { box: string; text: TokenName }> = {
  primary: { box: "bg-primary border border-primary active:opacity-80 hover:bg-blue", text: "primary-foreground" },
  outlined: { box: "bg-field border border-input active:bg-hover hover:border-ring", text: "foreground" },
  plain: { box: "border border-transparent active:bg-selection hover:bg-hover", text: "subtle" },
  danger: { box: "bg-destructive border border-destructive active:opacity-80", text: "destructive-foreground" },
  highlight: { box: "bg-warn border border-warn-dark active:opacity-80", text: "primary-foreground" },
  "ghost-danger": { box: "border border-transparent active:bg-selection hover:bg-hover", text: "danger" },
};

const BUTTON_SIZES: Record<ButtonSize, { box: string; text: string; icon: number; square: string }> = {
  md: { box: "min-h-9 px-4 gap-2", text: "text-sm", icon: 18, square: "size-9" },
  sm: { box: "min-h-8 px-3 gap-1.5", text: "text-sm", icon: 16, square: "size-8" },
  xs: { box: "min-h-7 px-2.5 gap-1.5", text: "text-xs", icon: 15, square: "size-7" },
  xxs: { box: "min-h-6 px-2 gap-1", text: "text-xs", icon: 13, square: "size-6" },
};

export interface ButtonProps {
  /** primary (the default commit), outlined, plain (quiet), danger, highlight, ghost-danger. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The button's text. */
  label?: string;
  /** An icon before the text, or the whole button with `iconOnly`. */
  icon?: IconName;
  /** A square icon button; give `title` for its tooltip and accessible name. */
  iconOnly?: boolean;
  /** The tooltip, and the accessible name when there is no label. */
  title?: string;
  disabled?: boolean;
  /** Busy: shows a spinner and blocks presses. */
  loading?: boolean;
  /** Full width. */
  block?: boolean;
  selected?: boolean;
  class?: string;
  testID?: string;
  onPress?: () => void;
  /** Anything after the label (a count, a caret). */
  children?: JSX.Element;
}

/** The console's button: one command, any input. */
export function Button(props: ButtonProps) {
  const variant = () => BUTTON_VARIANTS[props.variant ?? "primary"];
  const size = () => BUTTON_SIZES[props.size ?? "sm"];
  const enabled = () => !props.disabled && !props.loading;
  return (
    <BaseButton
      disabled={!enabled()}
      selected={props.selected}
      onPress={() => enabled() && props.onPress?.()}
      accessibilityLabel={props.label || props.title || props.icon || undefined}
      testID={props.testID}
      tooltip={
        props.title ? (
          <Tooltip class="bg-foreground px-2 py-1">
            <Text class="text-xs text-background">{props.title}</Text>
          </Tooltip>
        ) : undefined
      }
      class={`flex-row items-center justify-center rounded-(--radius) disabled:opacity-45 focus:border-ring ${variant().box} ${
        props.iconOnly ? size().square : size().box
      } ${props.block ? "self-stretch" : "self-start"} ${props.selected ? "bg-selection" : ""} ${props.class ?? ""}`}
    >
      <If when={props.loading}>
        <Spinner size={14} />
      </If>
      <If when={props.icon && !props.loading}>
        <Icon name={props.icon!} size={size().icon} color={variant().text} />
      </If>
      <If when={props.label && !props.iconOnly}>
        <Text class={`${size().text} font-medium`} style={{ color: token(variant().text) as string, numberOfLines: 1 }}>
          {props.label}
        </Text>
      </If>
      {props.children}
    </BaseButton>
  );
}

/* ---------- fields ---------- */

export interface TextFieldProps {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  onKeyPress?: (key: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  /** A label above the field. */
  label?: string;
  /** A hint below it. */
  hint?: string;
  /** An error below it, in place of the hint. */
  error?: string;
  masked?: boolean;
  multiline?: boolean;
  /** Visible lines of a multiline field. */
  rows?: number;
  disabled?: boolean;
  readonly?: boolean;
  /** Mono text: paths, keys, ids, code. */
  mono?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  keyboardType?: "default" | "email-address" | "numeric" | "url" | "number-pad" | "decimal-pad" | "phone-pad";
  /** An icon inside the field, before the text. */
  leadingIcon?: IconName;
  /** Something inside the field, after the text (a reveal button, a unit). */
  trailing?: JSX.Element;
  class?: string;
  inputClass?: string;
  testID?: string;
  accessibilityLabel?: string;
  inputRef?: (ref: InputRef) => void;
}

/** A text field with its label, hint and error, as the Vue console's AppInput and AppTextarea. */
export function TextField(props: TextFieldProps) {
  const lines = () => Math.max(1, props.rows ?? (props.multiline ? 3 : 1));
  return (
    <View class={`gap-1 ${props.class ?? ""}`}>
      <If when={props.label}>
        <Text class="text-xs font-medium text-subtle">{props.label}</Text>
      </If>
      <View
        class={`flex-row items-center gap-2 rounded-(--radius) border bg-field px-2.5 ${
          props.error ? "border-danger" : "border-input"
        } ${props.disabled ? "opacity-50" : ""}`}
      >
        <If when={props.leadingIcon}>
          <Icon name={props.leadingIcon!} size={15} color="muted-foreground" />
        </If>
        <Input
          ref={(node: InputRef) => props.inputRef?.(node)}
          value={props.value}
          onChange={({ value }) => props.onChange?.(value)}
          onSubmit={({ text }) => props.onSubmit?.(text)}
          onKeyPress={props.onKeyPress ? ({ key }) => props.onKeyPress?.(key) : undefined}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          placeholder={props.placeholder}
          masked={props.masked}
          multiline={props.multiline}
          readonly={props.readonly || props.disabled}
          autoFocus={props.autoFocus}
          maxLength={props.maxLength}
          keyboardType={props.keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={props.accessibilityLabel || props.label || props.placeholder}
          testID={props.testID}
          class={`flex-1 py-1.5 text-sm text-foreground placeholder:text-placeholder ${props.mono ? "font-mono" : ""} ${
            props.inputClass ?? ""
          }`}
          style={props.multiline ? { minHeight: lines() * 20 + 12 } : undefined}
        />
        {props.trailing}
      </View>
      <If when={props.error || props.hint}>
        <Text class={`text-xs ${props.error ? "text-danger" : "text-muted-foreground"}`}>{props.error || props.hint}</Text>
      </If>
    </View>
  );
}

/** A switch with its label (the Vue console's AppSwitch). */
export function Toggle(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  class?: string;
  testID?: string;
}) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.label}
      testID={props.testID}
      class={`flex-row items-center gap-2.5 disabled:opacity-45 ${props.class ?? ""}`}
      trackClass="w-8 h-4.5 rounded-full bg-line p-0.5 transition-colors checked:bg-blue"
      thumbClass="size-3.5 rounded-full bg-card transition-transform checked:translate-x-3.5"
    >
      <If when={props.label || props.hint}>
        <View class="flex-1 gap-0.5">
          <If when={props.label}>
            <Text class="text-sm text-foreground">{props.label}</Text>
          </If>
          <If when={props.hint}>
            <Text class="text-xs text-muted-foreground">{props.hint}</Text>
          </If>
        </View>
      </If>
    </Switch>
  );
}

/** A checkbox with its label. */
export function CheckboxField(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  indeterminate?: boolean;
  class?: string;
}) {
  return (
    <BaseCheckbox
      checked={props.checked}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.label}
      class={`flex-row items-center gap-2 disabled:opacity-45 ${props.class ?? ""}`}
      indicatorClass="size-4 items-center justify-center rounded-(--radius) border border-input bg-field checked:bg-blue checked:border-blue"
      indicator={<Icon name="PhCheck" size={12} color="primary-foreground" />}
    >
      <If when={props.label}>
        <Text class="text-sm text-foreground">{props.label}</Text>
      </If>
    </BaseCheckbox>
  );
}

export interface Choice {
  value: string;
  label: string;
  /** A second line or a note beside the label. */
  description?: string;
  disabled?: boolean;
}

/** A dropdown of choices (the Vue console's AppSelect / AppDropdownMenu in select mode). */
export function SelectField(props: {
  items: Choice[];
  value: string | null;
  onChange?: (value: string) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  class?: string;
  testID?: string;
}) {
  const current = () => props.items.find((item) => item.value === props.value);
  return (
    <View class={`gap-1 ${props.class ?? ""}`}>
      <If when={props.label}>
        <Text class="text-xs font-medium text-subtle">{props.label}</Text>
      </If>
      <Select
        items={props.items.map((item) => ({ value: item.value, title: item.label, disabled: item.disabled }))}
        value={props.value}
        disabled={props.disabled}
        searchable={props.searchable}
        accessibilityLabel={props.label || props.placeholder}
        onChange={({ value }) => value !== null && props.onChange?.(value)}
        testID={props.testID}
        class="flex-row items-center justify-between gap-2 rounded-(--radius) border border-input bg-field px-2.5 py-1.5 disabled:opacity-50"
        popupClass="rounded-(--radius) border border-border bg-popover py-1 shadow-md"
        itemClass="px-3 py-1.5 text-sm text-foreground hover:bg-hover selected:bg-selection"
        searchClass="mx-2 mb-1 rounded-(--radius) border border-input px-2 py-1 text-sm"
        trigger={
          <View class="flex-1 flex-row items-center justify-between gap-2">
            <Text class={`flex-1 text-sm ${current() ? "text-foreground" : "text-placeholder"} line-clamp-1`}>
              {current()?.label ?? props.placeholder ?? ""}
            </Text>
            <Icon name="PhCaretDown" size={12} color="muted-foreground" />
          </View>
        }
      />
      <If when={props.hint}>
        <Text class="text-xs text-muted-foreground">{props.hint}</Text>
      </If>
    </View>
  );
}

/* ---------- menus ---------- */

export interface MenuEntry {
  id: string;
  label?: string;
  icon?: IconName;
  /** Red: deletes or cannot be undone. */
  danger?: boolean;
  disabled?: boolean;
  /** A check mark beside it (a current choice). */
  checked?: boolean;
  separator?: boolean;
  /** A second line under the label. */
  description?: string;
  onSelect?: () => void;
}

/** A menu of commands opened from a trigger (the Vue console's AppMenu and dropdown menus). */
export function DropdownMenu(props: {
  trigger: JSX.Element;
  items: MenuEntry[];
  placement?: "bottom" | "top" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger does not open the menu (while its page saves or loads). */
  disabled?: boolean;
  class?: string;
}) {
  return (
    <If when={!props.disabled} else={<View class="opacity-45">{props.trigger}</View>}>
    <Menu
      trigger={props.trigger}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "end"}
      open={props.open}
      onOpenChange={({ open }) => props.onOpenChange?.(open)}
      popupClass={`min-w-44 rounded-(--radius) border border-border bg-popover py-1 shadow-md ${props.class ?? ""}`}
    >
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <If
            when={!item().separator}
            else={<MenuSeparator class="my-1 h-px bg-line-faint" />}
          >
            <MenuItem
              disabled={item().disabled}
              checked={item().checked ?? null}
              onSelect={() => item().onSelect?.()}
              class="flex-row items-center gap-2 px-3 py-1.5 hover:bg-hover focus:bg-hover disabled:opacity-45"
            >
              <If when={item().icon}>
                <Icon name={item().icon!} size={15} color={item().danger ? "danger" : "subtle"} />
              </If>
              <View class="flex-1">
                <Text class={`text-sm ${item().danger ? "text-danger" : "text-foreground"}`}>{item().label}</Text>
                <If when={item().description}>
                  <Text class="text-xs text-muted-foreground">{item().description}</Text>
                </If>
              </View>
              <If when={item().checked}>
                <Icon name="PhCheck" size={14} color="blue" />
              </If>
            </MenuItem>
          </If>
        )}
      </Each>
    </Menu>
    </If>
  );
}

/* ---------- surfaces ---------- */

/** A tag: neutral metadata, or a scarce semantic tone. */
export function Badge(props: { tone?: Tone; label?: string; children?: JSX.Element; class?: string }) {
  const cls = () => {
    switch (props.tone) {
      case "info":
        return { box: "border-blue-lighter bg-selection", text: "text-blue-dark" };
      case "ok":
        return { box: "border-ok bg-card", text: "text-ok" };
      case "warn":
        return { box: "border-warn bg-card", text: "text-warn-dark" };
      case "danger":
        return { box: "border-danger bg-card", text: "text-danger" };
      default:
        return { box: "border-line bg-card", text: "text-subtle" };
    }
  };
  return (
    <View class={`flex-row items-center gap-1 self-start rounded-(--radius) border px-1.5 py-px ${cls().box} ${props.class ?? ""}`}>
      <If when={props.label}>
        <Text class={`font-mono text-xs ${cls().text}`}>{props.label}</Text>
      </If>
      {props.children}
    </View>
  );
}

export function Divider(props: { vertical?: boolean; class?: string }) {
  return <View class={`${props.vertical ? "w-px self-stretch" : "h-px self-stretch"} bg-line-faint ${props.class ?? ""}`} />;
}

/** A bordered panel. */
export function Card(props: { children?: JSX.Element; class?: string; onPress?: () => void; testID?: string }) {
  return (
    <View
      testID={props.testID}
      onPress={props.onPress}
      class={`rounded-(--radius) border border-line-faint bg-card ${props.onPress ? "active:bg-hover" : ""} ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

/** A titled group of a page (the Vue console's AppSection). */
export function Section(props: {
  title?: string;
  meta?: string;
  actions?: JSX.Element;
  children?: JSX.Element;
  /** card: bordered panel; plain: just the heading. */
  variant?: "plain" | "card";
  class?: string;
}) {
  return (
    <View
      class={`gap-3 ${props.variant === "card" ? "rounded-(--radius) border border-line-faint bg-card p-4" : ""} ${
        props.class ?? ""
      }`}
    >
      <If when={props.title || props.actions}>
        <View class="flex-row items-center justify-between gap-3">
          <View class="flex-1 gap-0.5">
            <If when={props.title}>
              <Text class="text-base font-semibold text-foreground">{props.title}</Text>
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

/** Placeholder rows while something loads. */
export function Skeleton(props: { rows?: number; label?: string; class?: string }) {
  const widths = [92, 76, 84, 64, 88, 70];
  const rows = () => Array.from({ length: Math.max(1, props.rows ?? 6) }, (_, i) => widths[i % widths.length]);
  return (
    <View class={`gap-3 ${props.class ?? ""}`} accessibilityLabel={props.label || "Loading"}>
      <Each of={rows()}>{(width) => <View class="h-3 rounded-(--radius) bg-muted" style={{ width: `${width()}%` }} />}</Each>
    </View>
  );
}

/** What a list says when it has nothing. */
export function EmptyState(props: { title: string; text?: string; icon?: IconName; action?: JSX.Element; class?: string }) {
  return (
    <View class={`items-center gap-2 px-6 py-10 ${props.class ?? ""}`}>
      <If when={props.icon}>
        <Icon name={props.icon!} size={28} color="muted-foreground" />
      </If>
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <If when={props.text}>
        <Text class="text-center text-xs text-muted-foreground">{props.text}</Text>
      </If>
      {props.action}
    </View>
  );
}

/** A progress bar, 0..1. */
export function ProgressBar(props: { value?: number; indeterminate?: boolean; tone?: Tone; class?: string; label?: string }) {
  const bar = () => (props.tone === "danger" ? "bg-danger" : props.tone === "warn" ? "bg-warn" : props.tone === "ok" ? "bg-ok" : "bg-blue");
  return (
    <Progress
      value={props.value}
      indeterminate={props.indeterminate}
      accessibilityLabel={props.label}
      class={props.class}
      trackClass="h-1 overflow-hidden rounded-full bg-muted"
      indicatorClass={`h-1 rounded-full ${bar()}`}
    />
  );
}

/** Tabs as the Vue console's AppTabs: a row of quiet buttons with the current one marked. */
export function Tabs(props: {
  items: { id: string; label: string; count?: number; disabled?: boolean }[];
  value: string;
  onChange?: (id: string) => void;
  class?: string;
}) {
  return (
    <View class={`flex-row gap-1 border-b border-line-faint ${props.class ?? ""}`} role="tablist">
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <BaseButton
            role="tab"
            selected={props.value === item().id}
            disabled={item().disabled}
            onPress={() => props.onChange?.(item().id)}
            accessibilityLabel={item().label}
            class="-mb-px flex-row items-center gap-1.5 border-b-2 border-transparent px-2.5 py-2 hover:bg-hover selected:border-blue disabled:opacity-45"
          >
            <Text class={`text-sm ${props.value === item().id ? "font-medium text-foreground" : "text-subtle"}`}>{item().label}</Text>
            <If when={item().count !== undefined}>
              <Text class="font-mono text-xs text-muted-foreground">{String(item().count)}</Text>
            </If>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}

/* ---------- dialogs ---------- */

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";
const MODAL_WIDTHS: Record<ModalSize, string> = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-lg",
  lg: "w-full max-w-2xl",
  xl: "w-full max-w-4xl",
  full: "w-full h-full",
};

/** A dialog over the window (the Vue console's AppDialog): title, body, footer of actions. */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: ModalSize;
  /** Actions at the bottom, the default commit last. */
  footer?: JSX.Element;
  /** Something at the right of the title bar. */
  headerActions?: JSX.Element;
  /** Whether the body scrolls (default true). */
  scroll?: boolean;
  children?: JSX.Element;
  testID?: string;
  closeLabel?: string;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      testID={props.testID}
      animation="fade"
      backdropClass="bg-scrim"
      class={`m-auto max-h-[90%] ${MODAL_WIDTHS[props.size ?? "md"]} rounded-(--radius) border border-line bg-popover shadow-xl`}
    >
      <View class="flex-row items-start gap-3 border-b border-line-faint px-4 py-3">
        <View class="flex-1 gap-0.5">
          <If when={props.title}>
            <Text class="text-base font-semibold text-foreground" role="header">
              {props.title}
            </Text>
          </If>
          <If when={props.description}>
            <Text class="text-xs text-muted-foreground">{props.description}</Text>
          </If>
        </View>
        {props.headerActions}
        <Button variant="plain" size="xs" iconOnly icon="PhX" title={props.closeLabel ?? "Close"} onPress={props.onClose} />
      </View>
      <If when={props.scroll !== false} else={<View class="flex-1 p-4">{props.children}</View>}>
        <Scroll class="shrink" contentClass="p-4 gap-3">
          {props.children}
        </Scroll>
      </If>
      <If when={props.footer}>
        <View class="flex-row flex-wrap items-center justify-end gap-2 border-t border-line-faint px-4 py-3">{props.footer}</View>
      </If>
    </Dialog>
  );
}

export interface MessageAction {
  id: string;
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  onPress?: () => void;
}

/** A short message with its choices (the Vue console's AppMessageDialog). */
export function MessageDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  text?: string;
  icon?: IconName;
  tone?: Tone;
  actions: MessageAction[];
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      testID={props.testID}
      animation="fade"
      backdropClass="bg-scrim"
      class="m-auto w-full max-w-sm gap-3 rounded-(--radius) border border-line bg-popover p-5 shadow-xl"
    >
      <View class="flex-row items-center gap-2">
        <If when={props.icon}>
          <Icon name={props.icon!} size={20} color={props.tone === "danger" ? "danger" : "blue"} />
        </If>
        <Text class="flex-1 text-base font-semibold text-foreground" role="header">
          {props.title}
        </Text>
      </View>
      <If when={props.text}>
        <Text class="text-sm text-subtle">{props.text}</Text>
      </If>
      {props.children}
      <View class="flex-row flex-wrap justify-end gap-2 pt-1">
        <Each of={props.actions} key={(action) => action.id}>
          {(action) => (
            <Button
              variant={action().variant ?? "outlined"}
              label={action().label}
              disabled={action().disabled}
              loading={action().loading}
              onPress={() => action().onPress?.()}
              testID={`dialog-action-${action().id}`}
            />
          )}
        </Each>
      </View>
    </Dialog>
  );
}

/* ---------- confirm, as a promise ---------- */

interface ConfirmRequest {
  title: string;
  text?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
const confirmRequest = signal<ConfirmRequest | null>(null);

/** Asks a yes or no question; resolves true on confirm. Rendered by `ConfirmHost` in the shell. */
export function confirm(options: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    untracked(() => confirmRequest())?.resolve(false);
    confirmRequest.set({ ...options, resolve });
  });
}

export function ConfirmHost() {
  const answer = (ok: boolean) => {
    const request = untracked(() => confirmRequest());
    confirmRequest.set(null);
    request?.resolve(ok);
  };
  return (
    <MessageDialog
      open={confirmRequest() !== null}
      onClose={() => answer(false)}
      title={confirmRequest()?.title ?? ""}
      text={confirmRequest()?.text}
      icon={confirmRequest()?.danger ? "PhWarning" : "PhQuestion"}
      tone={confirmRequest()?.danger ? "danger" : "info"}
      actions={[
        { id: "cancel", label: confirmRequest()?.cancelLabel ?? "", variant: "outlined", onPress: () => answer(false) },
        {
          id: "confirm",
          label: confirmRequest()?.confirmLabel ?? "",
          variant: confirmRequest()?.danger ? "danger" : "primary",
          onPress: () => answer(true),
        },
      ]}
    />
  );
}

/* ---------- notices ---------- */

/** The floating notice stack (the Vue console's AppNoticeHost), fed by lib/core/notices.js. */
export function NoticeHost(props: { class?: string }) {
  const tone = (type: string) =>
    type === "error" ? "border-danger" : type === "warning" ? "border-warn" : type === "success" ? "border-ok" : "border-blue";
  const icon = (type: string): IconName =>
    type === "error" ? "PhWarningCircle" : type === "warning" ? "PhWarning" : type === "success" ? "PhCheckCircle" : "PhInfo";
  const color = (type: string): TokenName =>
    type === "error" ? "danger" : type === "warning" ? "warn-dark" : type === "success" ? "ok" : "blue";
  return (
    <View class={`absolute bottom-4 right-4 w-80 max-w-[90%] gap-2 ${props.class ?? ""}`} style={{ pointerEvents: "box-none" }}>
      <Each of={noticeState.items as { id: string; type: string; text: string; label: string }[]} key={(item) => item.id}>
        {(item) => (
          <View
            role="alert"
            class={`flex-row items-start gap-2 rounded-(--radius) border-l-2 bg-popover px-3 py-2 shadow-md ${tone(item().type)}`}
          >
            <Icon name={icon(item().type)} size={16} color={color(item().type)} />
            <View class="flex-1 gap-0.5">
              <If when={item().label}>
                <Text class="font-mono text-xs uppercase text-muted-foreground">{item().label}</Text>
              </If>
              <View selectable>
                <Text class="text-sm text-foreground">{item().text}</Text>
              </View>
            </View>
            <Button variant="plain" size="xxs" iconOnly icon="PhX" title="Dismiss" onPress={() => dismissNotice(item().id)} />
          </View>
        )}
      </Each>
    </View>
  );
}

/** Shows `error` in the notice stack while it is set, as the Vue console's AppPage did. */
export function usePageError(error: () => string, id = `page-error-${Math.random().toString(36).slice(2)}`) {
  effect(() => {
    const text = String(error() || "").trim();
    untracked(() => {
      if (text) pushNotice({ id, type: "error", text, timeout: 0 });
      else dismissNotice(id);
    });
  });
  cleanup(() => dismissNotice(id));
}

/* ---------- the page frame ---------- */

/** A workspace page: its bar (title, actions) and its body (the Vue console's AppPage). */
export function Page(props: {
  title?: string;
  /** Replaces the title in the bar (a picker, a breadcrumb). */
  leading?: JSX.Element;
  actions?: JSX.Element;
  /** A page-level error: shown in the notice stack while set. */
  error?: string;
  /** Whether the body scrolls as one (default true); false for pages that own their scrolling. */
  scroll?: boolean;
  hideBar?: boolean;
  children?: JSX.Element;
  bodyClass?: string;
  testID?: string;
}) {
  usePageError(() => props.error ?? "");
  return (
    <View class="flex-1 bg-background" testID={props.testID}>
      <If when={!props.hideBar}>
        <View class="min-h-12 flex-row items-center justify-between gap-3 border-b border-line-faint px-5 py-2">
          <View class="flex-1 flex-row items-center gap-2">
            <If when={props.leading} else={<Text class="text-lg font-semibold text-foreground line-clamp-1" role="header">{props.title}</Text>}>
              {props.leading}
            </If>
          </View>
          <If when={props.actions}>
            <View class="flex-row items-center gap-1.5">{props.actions}</View>
          </If>
        </View>
      </If>
      <If when={props.scroll !== false} else={<View class={`flex-1 ${props.bodyClass ?? ""}`}>{props.children}</View>}>
        <Scroll class="flex-1" contentClass={`gap-5 p-5 ${props.bodyClass ?? ""}`}>
          {props.children}
        </Scroll>
      </If>
    </View>
  );
}

/* ---------- side pane and floating action ---------- */

/**
 * The panel at the right of a list that edits or inspects one of its items (the Vue console's
 * AppSidePane). On wide windows it is a column beside the list: put it last in a `flex-row`.
 * With `sheet` (phones) it is a drawer from the right over a scrim. Escape closes it.
 */
export function SidePane(props: {
  open: boolean;
  onClose: () => void;
  sheet?: boolean;
  label?: string;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <If
      when={props.sheet}
      else={
        <If when={props.open}>
          <SidePaneColumn onClose={props.onClose} label={props.label} class={props.class}>
            {props.children}
          </SidePaneColumn>
        </If>
      }
    >
      <Sheet
        open={props.open}
        side="right"
        onOpenChange={({ open }) => {
          if (!open) props.onClose();
        }}
        backdropClass="bg-scrim"
        popupClass={`h-full w-[88%] max-w-md border-l border-line bg-card ${props.class ?? ""}`}
      >
        {props.children}
      </Sheet>
    </If>
  );
}

function SidePaneColumn(props: { onClose: () => void; label?: string; class?: string; children?: JSX.Element }) {
  keymap.bind("escape", () => props.onClose());
  return (
    <View accessibilityLabel={props.label} class={`w-96 border-l border-line-faint bg-card ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

/** The floating add button of a page (the Vue console's AppFab): bottom right, over the content. */
export function Fab(props: { label: string; icon?: IconName; disabled?: boolean; onPress?: () => void; testID?: string }) {
  return (
    <BaseButton
      onPress={() => props.onPress?.()}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      testID={props.testID}
      tooltip={
        <Tooltip class="bg-foreground px-2 py-1">
          <Text class="text-xs text-background">{props.label}</Text>
        </Tooltip>
      }
      class="absolute bottom-5 right-5 size-12 items-center justify-center rounded-full bg-primary shadow-lg active:opacity-80 disabled:opacity-45"
    >
      <Icon name={props.icon ?? "PhPlus"} size={22} color="primary-foreground" />
    </BaseButton>
  );
}
