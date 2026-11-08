// Small pieces of the Settings page (SettingsView.css): a field with its label and note, a toggle
// row, a row with a control at its right, a fold (the Vue page's <details>), and a dot.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton, Collapsible, Switch } from "nsh/base";
import { isMobile } from "../../lib/shell";
import { Icon, type IconName } from "../ui";
import { useRevealRow } from "./reveal";

export { LoadingLine } from "../ui";

/** "Restart required" beside a label or under a toggle's note (`.config-settings-restart`): quiet mono. */
export function RestartTag(props: { label?: string }) {
  return (
    <Text class="min-w-0 shrink font-mono text-[11px] tracking-[0.04em] text-muted-foreground" style={{ numberOfLines: 1 }}>
      {props.label ?? "Restart required"}
    </Text>
  );
}

/**
 * The settings switch (base.css `.q-switch`): a small hairline track, empty when off and ink when
 * on, with a square knob on a hairline that slides across and settles with a slight give.
 */
export function SettingSwitch(props: {
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      class="disabled:opacity-45"
      trackClass="w-[34px] h-5 rounded-(--radius) border border-line bg-transparent p-0.5 transition-colors duration-180 hover:border-muted-foreground checked:border-primary checked:bg-primary"
      thumbClass="size-3.5 rounded-[1px] bg-card ring-1 ring-foreground/20 shadow-xs transition-transform duration-260 ease-[cubic-bezier(0.3,1.35,0.5,1)] checked:translate-x-3.5 checked:ring-primary/60"
    />
  );
}

/** A labelled field: label above, the control, a note below (`.settings-field`). */
export function SettingField(props: { label: string; note?: string; children?: JSX.Element; right?: JSX.Element; testID?: string; class?: string }) {
  const reveal = useRevealRow(() => props.label);
  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      class={`gap-[5px] rounded-(--radius) ${reveal.ringed() ? "ring-2 ring-blue" : ""} ${props.class ?? ""}`}
      testID={props.testID}
    >
      <View class="flex-row items-center justify-between gap-3">
        <Text class="min-w-0 shrink text-sm font-medium leading-[18.9px] text-foreground">{props.label}</Text>
        <If when={props.right}>
          <View class="shrink-0">{props.right}</View>
        </If>
      </View>
      {props.children}
      <If when={props.note}>
        <Text class="text-xs leading-normal text-muted-foreground">{props.note}</Text>
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
  /** Under the note ("Restart required"). */
  extra?: JSX.Element;
  first?: boolean;
  testID?: string;
}) {
  const reveal = useRevealRow(() => props.title);
  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      class={`flex-row items-center gap-4 rounded-(--radius) py-3 ${props.first ? "" : "border-t border-line-soft"} ${
        reveal.ringed() ? "ring-2 ring-blue" : ""
      }`}
      testID={props.testID}
    >
      <View class="min-w-0 flex-1 flex-row items-start gap-2.5">
        {props.leading}
        <View class="min-w-0 flex-1 gap-1">
          <Text class="text-sm font-medium leading-[18.9px] text-foreground">{props.title}</Text>
          <If when={props.note}>
            <Text class="text-xs leading-[20.3px] text-muted-foreground">{props.note}</Text>
          </If>
          {props.extra}
        </View>
      </View>
      <View class="flex-row items-center gap-2">
        {props.actions}
        <If
          when={props.control}
          else={
            <SettingSwitch
              checked={props.checked}
              disabled={props.disabled}
              onChange={(checked) => props.onChange?.(checked)}
              accessibilityLabel={props.title}
              testID={props.testID ? `${props.testID}-switch` : undefined}
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
export function SettingRow(props: {
  title: string;
  note?: string;
  status?: JSX.Element;
  children?: JSX.Element;
  first?: boolean;
  testID?: string;
  /** Classes of the title column (a width cap where the control should take the room). */
  copyClass?: string;
  /** The control stays beside the title on phones too (a switch, an icon button). */
  inline?: boolean;
}) {
  const reveal = useRevealRow(() => props.title);
  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      class={`rounded-(--radius) py-3 ${
        isMobile() && !props.inline ? "gap-4" : "flex-row items-center gap-4"
      } ${props.first ? "" : "border-t border-line-soft"} ${reveal.ringed() ? "ring-2 ring-blue" : ""}`}
      testID={props.testID}
    >
      <View class={`min-w-0 flex-1 gap-1 ${props.copyClass ?? ""}`}>
        <Text class="text-sm font-medium leading-[18.9px] text-foreground">{props.title}</Text>
        <If when={props.note}>
          <Text class="text-xs leading-[20.3px] text-muted-foreground">{props.note}</Text>
        </If>
        {props.status}
      </View>
      {props.children}
    </View>
  );
}

/**
 * Content folded under a summary line (the Vue page's <details>): a caret that turns a quarter
 * when open (`.settings-remote-advanced`), a 14pt title over a 12pt note. Folded content keeps
 * its drafts.
 */
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
    <Collapsible open={props.open} content={<View class="gap-4 pt-4">{props.children}</View>} class={props.class}>
      <View
        role="button"
        accessibilityLabel={props.title}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        testID={props.testID}
        class="flex-row items-center gap-3 border-t border-line-soft p-4"
      >
        <View
          class="transition-transform duration-160"
          style={{ transform: [{ rotate: props.open ? "90deg" : "0deg" }] }}
        >
          <Icon name="PhCaretRight" size={16} color="muted-foreground" />
        </View>
        <View class="flex-1 gap-1">
          <Text class="text-sm font-medium text-foreground">{props.title}</Text>
          <If when={props.note}>
            <Text class="text-xs text-muted-foreground">{props.note}</Text>
          </If>
        </View>
      </View>
    </Collapsible>
  );
}

/**
 * A boxed fold (`.settings-system-advanced`): a 54pt bar with its title at the left and a caret at
 * the right that turns over when open.
 */
export function BoxFold(props: { open: boolean; onToggle: () => void; title: string; children?: JSX.Element; testID?: string }) {
  return (
    <Collapsible open={props.open} content={<View class="gap-4 pt-4">{props.children}</View>}>
      <View
        role="button"
        accessibilityLabel={props.title}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        testID={props.testID}
        class="min-h-[54px] flex-row items-center justify-between gap-3 border border-line-soft bg-paper px-5"
      >
        <Text class="text-base font-semibold text-subtle">{props.title}</Text>
        <View class="transition-transform duration-160" style={{ transform: [{ rotate: props.open ? "180deg" : "0deg" }] }}>
          <Icon name="PhCaretDown" size={16} color="subtle" />
        </View>
      </View>
    </Collapsible>
  );
}

/** The small mark of unsaved changes (`.settings-channel-tile-dirty`): a 7pt square, waiting orange. */
export function DirtyDot(props: { label: string; testID?: string; class?: string }) {
  return (
    <View
      accessibilityLabel={props.label}
      testID={props.testID}
      class={`size-[7px] rounded-[1px] bg-status-pending ${props.class ?? ""}`}
    />
  );
}

/**
 * A titled block (the Vue console's AppSection). The head is one 48pt strip: a mono caps label, the
 * meta beside it on one line (cut where it does not fit), plain actions at the far end, on a
 * hairline. `boxed` (the default) frames it in a hairline on the paper with a 16pt body; `plain`
 * has no frame, the head's rule the only line (settings groups inside a box). `literal` keeps the
 * title's case (a name the user gave); `list` trims the body's inset for a list of padded rows.
 */
export function SettingsCard(props: {
  title?: string;
  meta?: string;
  /** Before the meta in the head (a count, "Restart required"). */
  metaLead?: JSX.Element;
  actions?: JSX.Element;
  /** Before the label: one plain back button. */
  lead?: JSX.Element;
  variant?: "boxed" | "plain";
  literal?: boolean;
  list?: boolean;
  /** Only the head (no body, no rule under the head). */
  headOnly?: boolean;
  children?: JSX.Element;
  testID?: string;
  class?: string;
  bodyClass?: string;
}) {
  const reveal = useRevealRow(() => props.title);
  const boxed = () => props.variant !== "plain";
  const pad = () => (isMobile() ? "px-3" : "px-4");
  const hasHead = () => Boolean(props.title || props.meta || props.metaLead || props.actions || props.lead);
  // A head-only box (nothing below the head) has no rule under its head. Children are not read to
  // find out: each read of props.children builds them again.
  const hasBody = () => !props.headOnly;
  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      class={`min-w-0 ${boxed() ? "rounded-(--radius) border bg-paper/70" : "gap-4"} ${
        reveal.ringed() ? "border-blue ring-2 ring-blue" : "border-line-soft"
      } ${props.class ?? ""}`}
      testID={props.testID}
    >
      <If when={hasHead()}>
        <View
          class={`flex-row items-center gap-2.5 ${boxed() ? `h-12 ${pad()}` : "h-11"} ${
            hasBody() ? "border-b border-line-soft" : ""
          }`}
        >
          <If when={props.lead}>
            <View class="-ml-2 -mr-1 h-8 flex-row items-center">{props.lead}</View>
          </If>
          <If when={props.title}>
            <Text
              role="header"
              class={`shrink font-mono text-[11px] font-semibold leading-[15.4px] text-subtle ${
                props.literal ? "tracking-[0.02em]" : "uppercase tracking-[0.1em]"
              }`}
              style={{ numberOfLines: 1 }}
            >
              {props.title}
            </Text>
          </If>
          <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
            <If when={props.metaLead}>
              <View class="min-w-0 shrink flex-row items-center">{props.metaLead}</View>
            </If>
            <If when={props.meta}>
              <Text class="min-w-0 flex-1 text-xs leading-[17.4px] text-muted-foreground" style={{ numberOfLines: 1 }}>
                {props.meta}
              </Text>
            </If>
          </View>
          <If when={props.actions}>
            <View class="-mr-1.5 h-8 shrink-0 flex-row items-center justify-end gap-1">{props.actions}</View>
          </If>
        </View>
      </If>
      {/* A head-only box still mounts its children (a dialog its head's button opens). */}
      <View
        class={`min-w-0 gap-4 ${hasBody() && boxed() ? (props.list ? `${pad()} py-1` : isMobile() ? "p-3" : "p-4") : ""} ${
          props.bodyClass ?? ""
        }`}
      >
        {props.children}
      </View>
    </View>
  );
}

/**
 * The full-width dashed button that adds an item at the end of a list (`.settings-profile-placeholder`,
 * the ui-kit's `placeholder` button): 44pt, a dashed hairline, the label in the middle. Its look is
 * what Vue draws, measured: SettingsView.css gives it a 135deg hatching under a paper gradient, but
 * the morph theme's `.touchable.placeholder { background: … !important }` replaces that background,
 * so Vue shows white at 46% (68% on hover) on a blue dashed hairline at 36% (52%), 180ms.
 */
export function PlaceholderButton(props: { label: string; icon?: IconName; disabled?: boolean; onPress?: () => void; testID?: string; class?: string }) {
  return (
    <BaseButton
      onPress={() => props.onPress?.()}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      testID={props.testID}
      class={`h-11 flex-row items-center justify-center gap-2 rounded-(--radius) border border-dashed border-blue/36 bg-white/46 transition-colors duration-180 ease-in-out hover:border-blue/52 hover:bg-white/68 disabled:opacity-50 ${
        props.class ?? ""
      }`}
    >
      <Icon name={props.icon ?? "PhPlus"} size={16} color="subtle" />
      <Text class="text-sm font-medium text-subtle">{props.label}</Text>
    </BaseButton>
  );
}

/**
 * The head of a side pane (AppSidePane's AppSection head): one 50pt row, the mono caps title (its
 * own case with `literal`), the meta beside it on one line, then the pane's plain icon buttons.
 */
export function PaneHead(props: { title: string; meta?: string; literal?: boolean; actions?: JSX.Element; lead?: JSX.Element }) {
  return (
    <View class="h-[50px] flex-row items-center gap-2.5 border-b border-line-soft bg-paper px-4">
      <If when={props.lead}>
        <View class="-ml-2 -mr-1 h-8 flex-row items-center">{props.lead}</View>
      </If>
      <Text
        role="header"
        class={`shrink font-mono text-[11px] font-semibold leading-[15.4px] text-subtle ${
          props.literal ? "tracking-[0.02em]" : "uppercase tracking-[0.1em]"
        }`}
        style={{ numberOfLines: 1 }}
      >
        {props.title}
      </Text>
      <View class="min-w-0 flex-1">
        <If when={props.meta}>
          <Text class="text-xs leading-[17.4px] text-muted-foreground" style={{ numberOfLines: 1 }}>
            {props.meta}
          </Text>
        </If>
      </View>
      <If when={props.actions}>
        <View class="-mr-1.5 h-8 flex-row items-center gap-1">{props.actions}</View>
      </If>
    </View>
  );
}
