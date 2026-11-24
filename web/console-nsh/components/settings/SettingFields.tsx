// The settings field controls (the Vue console's Setting*.js and SettingFields.css): one box per
// value, the parts of the box split by a hairline, and a list (nsh/base Select) for the fields that
// offer choices. Every field keeps the stored text the Vue field kept, so the panels' drafts,
// validation and unsaved checks stay in lib/core.
//
// Vue to nsh: `modelValue` is `value`, `update:modelValue` is `onChange(value)`. The Vue
// `inject("settingsCanBrowsePaths")` is the SettingsCanBrowsePaths context (an accessor).
import type { InputRef, JSX } from "nsh";
import { batch, cleanup, context, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input, Select, Slider, Toggle } from "nsh/base";
import { durationSeconds, formatDuration, splitDuration } from "../../lib/core/duration.js";
import { pickDesktopDirectory } from "../../lib/core/desktop-runtime.js";
import { ROW_MODES } from "../../lib/core/setting-rows.js";
import { useRevealRow } from "../settings-page/reveal";
import { t } from "./DialogShell";
import { isMobile } from "../../lib/shell";
import { Icon, PopupList, popupSheets, Tip, TipButton } from "../ui";
import { CONTROL_CORNERS, cornersClass, nestedRadius, POPOVER_CORNERS, RADIUS } from "../corners";

/** A choice in a settings list. `hint` shows beside the title, `one` is a unit's singular title. */
export interface SettingOption {
  title: string;
  value: string;
  hint?: string;
  one?: string;
  placeholder?: string;
  disabled?: boolean;
}

/** A unit of a SettingQuantity: its title ("minutes"), singular title ("minute") and factor. */
export interface QuantityUnit {
  title: string;
  one?: string;
  value: number;
}

/**
 * Whether SettingPath offers Browse (the desktop app, editing this machine's settings). The Settings
 * page provides an accessor: `<SettingsCanBrowsePaths.Provider value={() => ...}>`.
 */
export const SettingsCanBrowsePaths = context<() => boolean>(() => false);

/** Inside a side pane: forms take one field per row (`.app-side-pane .settings-form-grid`). */
export const InSidePane = context<boolean>(false);

/* ---------- the box and its parts ---------- */

/** The classes of a field's box. */
export function boxClass(state: { disabled?: boolean; invalid?: boolean; open?: boolean } = {}) {
  // SettingFields.css `.sf-box`: 44pt high, the controls' continuous corners (it clips its parts'
  // fills to them), a hairline that firms up on hover and focus.
  return `h-11 flex-row items-stretch overflow-hidden ${CONTROL_CORNERS} border bg-field transition-colors duration-120 ${
    state.invalid ? "border-danger/60" : state.open ? "border-blue/60" : "border-input hover:border-ink/32"
  } ${state.disabled ? "opacity-50" : ""}`;
}

const INPUT_CLASS = "flex-1 min-w-0 px-3 py-2 text-sm text-foreground placeholder:text-placeholder";
const PART_CLASS = "flex-row items-center gap-1.5 px-3 hover:bg-blue/6 active:bg-blue/10 focus:bg-blue/10 disabled:opacity-50";
// The popovers' continuous corners; an item's highlight is inset 4pt from the sides as from the top
// and bottom (py-1), its corners nested by the hairline and the 4pt (12 - 5: 7pt), its text 12pt in.
const MENU_POPUP = `min-w-40 max-h-80 ${POPOVER_CORNERS} border border-line bg-popover py-1 shadow-md`;
/** The caret at the right of a list's trigger: it turns over while the list is open. */
function MenuCaret(props: { open: boolean }) {
  return (
    <Icon
      name="PhCaretDown"
      size={12}
      color="muted-foreground"
      class={`transition duration-180 ${props.open ? "rotate-180" : ""}`}
    />
  );
}

/** The gap between a trigger and its list. */
const MENU_GAP = 4;
const MENU_ITEM = `mx-1 flex-row items-center justify-between gap-3 px-2 py-1.5 ${cornersClass(nestedRadius(RADIUS.popover, 1 + 4))} hover:bg-hover focus:bg-hover selected:bg-selection disabled:opacity-50`;

/** The hairline between two parts of a box. */
function Sep() {
  return <View class="h-5 w-px self-center bg-input" accessibilityElementsHidden />;
}

/** A pressable part of a box: a unit, Browse, a remove button. Text or a glyph, not both: with an
 * `icon`, the label is its accessible name and its tooltip, not drawn (a menu's `caret` is no glyph). */
function Part(props: {
  label?: string;
  icon?: Parameters<typeof Icon>[0]["name"];
  caret?: boolean;
  quiet?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  tooltip?: string;
  testID?: string;
  onPress?: () => void;
}) {
  return (
    <TipButton
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      accessibilityLabel={props.accessibilityLabel || props.label}
      tooltip={props.icon && (props.label || props.accessibilityLabel) ? <Tip text={(props.label || props.accessibilityLabel)!} /> : undefined}
      testID={props.testID}
      class={PART_CLASS}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} size={14} color={props.quiet ? "muted-foreground" : "subtle"} />
      </If>
      <If when={props.label && !props.icon}>
        <Text class={`text-sm ${props.quiet ? "text-muted-foreground" : "text-subtle"}`} style={{ numberOfLines: 1 }}>
          {props.label}
        </Text>
      </If>
      <If when={props.caret}>
        <Icon name="PhCaretDown" size={12} color="muted-foreground" />
      </If>
    </TipButton>
  );
}

/* ---------- the field and its grid ---------- */

/**
 * A settings form's grid (the Vue console's `.settings-form-grid`): fields two to a row where there
 * is room, a wide field on a row of its own.
 */
export function SettingFieldGrid(props: { children?: JSX.Element; class?: string; testID?: string; tight?: boolean }) {
  const single = InSidePane() || false;
  // Two equal columns, 16pt apart (`.config-settings-fields`); `tight`: 12pt (`.settings-form-grid`,
  // the LLM form). A wide field spans the row (`col-span-full`). One column (a plain stack, where
  // every field takes the width) on phones and in side panes.
  return (
    <View
      class={`${single || isMobile() ? "" : "grid grid-cols-2"} ${props.tight ? "gap-3" : "gap-4"} ${props.class ?? ""}`}
      testID={props.testID}
    >
      {props.children}
    </View>
  );
}

/**
 * One field of a settings form (the Vue console's `.settings-field`): its label (with something at
 * its right, such as "Restart required"), the control, and a note below.
 */
export function SettingField(props: {
  label?: string;
  labelRight?: JSX.Element;
  note?: string;
  /** The note reads as a condition (italic): "Turn on X to change this." */
  noteItalic?: boolean;
  /** A row of its own in a SettingFieldGrid. */
  wide?: boolean;
  /** Dimmed: it cannot be changed right now. */
  inactive?: boolean;
  children?: JSX.Element;
  class?: string;
  testID?: string;
}) {
  // The Settings page's search scrolls to a field by its label and marks it.
  const reveal = useRevealRow(() => props.label);
  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      testID={props.testID}
      class={`min-w-0 gap-[5px] rounded-(--radius) ${props.wide ? "col-span-full" : ""} ${props.inactive ? "opacity-55" : ""} ${
        reveal.ringed() ? "ring-2 ring-blue" : ""
      } ${props.class ?? ""}`}
    >
      <If when={props.label || props.labelRight}>
        <View class="flex-row items-center justify-between gap-3">
          <Text class="min-w-0 shrink text-sm font-medium leading-[18.9px] text-foreground">{props.label ?? ""}</Text>
          <If when={props.labelRight}>
            <View class="shrink-0">{props.labelRight}</View>
          </If>
        </View>
      </If>
      {props.children}
      <If when={props.note}>
        <Text class={`text-xs leading-normal text-muted-foreground ${props.noteItalic ? "italic" : ""}`}>{props.note}</Text>
      </If>
    </View>
  );
}

/* ---------- SettingMenu ---------- */

export interface SettingMenuProps {
  items: SettingOption[];
  selected?: string | number | null;
  /** "start" lines the list up with the trigger's left edge, "end" with its right edge. */
  align?: "start" | "end";
  /** Desktops: the list is exactly as wide as the trigger (left out, at least as wide). */
  matchWidth?: boolean;
  /** What the list is of ("Level unit"). */
  label?: string;
  /** What screen readers call the trigger, when it says more than `label` ("Level: unit, minutes"). */
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Controlled open state (optional). */
  open?: boolean;
  /** What opens the list; as a function it is told whether the list is open (for `MenuCaret`). */
  trigger: JSX.Element | ((open: () => boolean) => JSX.Element);
  class?: string;
  testID?: string;
  onSelect?: (item: SettingOption) => void;
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The list behind every settings field that offers choices: the trigger opens it, the keys move in
 * it (Up, Down, Home, End, typeahead), Return or a press choose, Escape or a press outside close it.
 * The chosen item is marked; an item's hint shows at its right.
 */
export function SettingMenu(props: SettingMenuProps) {
  // Items are keyed by their place: values may repeat (a stored value equal to a preset's title).
  const selectedIndex = () => {
    const index = props.items.findIndex((item) => String(item.value) === String(props.selected ?? ""));
    return index >= 0 ? String(index) : null;
  };
  // Phones and touch screens: the list is the shared floating paper (`PopupList`); the base list
  // stays shut there (`open` held false) and only says when its trigger asks to open.
  const sheetOpen = signal(false);
  // The trigger's width, for a list that matches it.
  const triggerWidth = signal(0);
  // Whether the list shows, popup or sheet: what the trigger's caret turns with.
  const shown = signal(false);
  const setOpen = (open: boolean) => {
    sheetOpen.set(open);
    shown.set(open);
    props.onOpenChange?.(open);
    if (!open) props.onClose?.();
  };
  const choose = (value: string | null) => {
    if (value === null) return;
    const item = props.items[Number(value)];
    if (item && !item.disabled) props.onSelect?.(item);
  };
  return (
    <>
    <PopupList
      open={popupSheets() && (props.open ?? sheetOpen()) && !props.disabled}
      onClose={() => setOpen(false)}
      label={props.label || props.accessibilityLabel}
      items={props.items.map((item, index) => ({
        value: String(index),
        title: item.title,
        disabled: item.disabled,
        trailing: item.hint ? <Text class="font-mono text-xs text-muted-foreground">{item.hint}</Text> : undefined,
      }))}
      value={selectedIndex() ?? ""}
      onChoose={choose}
      partID={props.testID ? `${props.testID}-popup` : undefined}
    />
    <Select
      items={props.items.map((item, index) => ({ value: String(index), title: item.title, disabled: item.disabled }))}
      value={selectedIndex()}
      open={popupSheets() ? false : props.open}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel || props.label || undefined}
      align={props.align === "end" ? "end" : "start"}
      testID={props.testID}
      onChange={({ value }) => choose(value)}
      onOpenChange={({ open }) => {
        if (untracked(popupSheets)) {
          if (open) setOpen(true);
          return;
        }
        shown.set(open);
        props.onOpenChange?.(open);
        if (!open) props.onClose?.();
      }}
      class={`flex-row items-stretch ${props.class ?? ""}`}
      onLayout={({ bounds }) => triggerWidth.set(bounds.size.width)}
      offset={MENU_GAP}
      popupClass={MENU_POPUP}
      popupStyle={props.matchWidth && triggerWidth() > 0 ? { width: triggerWidth(), minWidth: 0 } : undefined}
      itemClass={MENU_ITEM}
      trigger={typeof props.trigger === "function" ? props.trigger(() => props.open ?? shown()) : props.trigger}
      renderItem={(entry) => (
        <View class="flex-1 flex-row items-center justify-between gap-3">
          <Text class="min-w-0 shrink text-sm text-foreground" style={{ numberOfLines: 1 }}>
            {entry.title}
          </Text>
          <If when={props.items[entry.index]?.hint}>
            <Text class="font-mono text-xs text-muted-foreground">{props.items[entry.index]?.hint ?? ""}</Text>
          </If>
        </View>
      )}
    />
    </>
  );
}

/* ---------- SettingSelect ---------- */

export interface SettingSelectProps {
  value: string;
  onChange?: (value: string) => void;
  options: (string | SettingOption)[];
  disabled?: boolean;
  /** The box is also where a value of one's own is typed. */
  allowCustom?: boolean;
  placeholder?: string;
  label?: string;
  /** Kept for callers; a custom value is typed straight into the box. */
  customLabel?: string;
  customPlaceholder?: string;
  testID?: string;
}

/**
 * A choice from a list, in one box. With allowCustom the box is also where a value of one's own is
 * typed: it shows the preset's name ("Every 30 minutes") until focused, then the stored text ("30m")
 * ready to edit, with the presets in the list behind the caret.
 */
export function SettingSelect(props: SettingSelectProps) {
  const editing = signal(false);
  const placeholder = () => props.placeholder ?? "Default";
  const presets = (): SettingOption[] =>
    (props.options || []).map((option) =>
      typeof option === "string" ? { title: option || placeholder(), value: option } : option,
    );
  const items = (): SettingOption[] => {
    const list = presets().map((item) => ({
      ...item,
      hint: props.allowCustom && item.value !== "" && item.value !== item.title ? item.value : "",
    }));
    // A stored value that is not a preset still shows, so it is never silently replaced.
    if (!props.allowCustom && !list.some((item) => item.value === props.value)) {
      list.push({ title: props.value || placeholder(), value: props.value, hint: "" });
    }
    return list;
  };
  const current = () => presets().find((item) => item.value === props.value) || null;
  const shownText = () => {
    if (props.allowCustom && editing()) return props.value ?? "";
    return current() ? current()!.title : props.value ?? "";
  };
  const pick = (item: SettingOption) => props.onChange?.(item.value);

  return (
    <If
      when={props.allowCustom}
      else={
        <SettingMenu
          items={items()}
          selected={props.value}
          matchWidth
          label={props.label}
          disabled={props.disabled}
          testID={props.testID}
          onSelect={pick}
          class={boxClass({ disabled: props.disabled })}
          trigger={(open) => (
            <View class="flex-1 flex-row items-center gap-2 px-3 py-2">
              <Text
                class={`flex-1 text-sm ${!current() && !props.value ? "text-placeholder" : "text-foreground"}`}
                style={{ numberOfLines: 1 }}
              >
                {shownText() || placeholder()}
              </Text>
              <MenuCaret open={open()} />
            </View>
          )}
        />
      }
    >
      <View class={boxClass({ disabled: props.disabled })}>
        <Input
          value={shownText()}
          placeholder={props.customPlaceholder || placeholder()}
          readonly={props.disabled}
          accessibilityLabel={props.label || undefined}
          testID={props.testID}
          autoCapitalize="none"
          autoCorrect={false}
          onFocus={() => editing.set(true)}
          onBlur={() => editing.set(false)}
          onChange={({ value }) => {
            if (!props.disabled) props.onChange?.(value);
          }}
          class={INPUT_CLASS}
        />
        <SettingMenu
          items={items()}
          selected={props.value}
          align="end"
          label={props.label}
          accessibilityLabel={props.label ? `${props.label}: show choices` : "Show choices"}
          disabled={props.disabled}
          testID={props.testID ? `${props.testID}-choices` : undefined}
          onSelect={pick}
          trigger={(open) => (
            <View class="items-center justify-center px-3 hover:bg-hover">
              <MenuCaret open={open()} />
            </View>
          )}
        />
      </View>
    </If>
  );
}

/* ---------- SettingQuantity, SettingDuration, SettingBytes ---------- */

export interface SettingQuantityProps {
  value: string;
  onChange?: (value: string) => void;
  units: QuantityUnit[];
  /** Stored text to { amount, unit }; null for text the units cannot show. */
  read: (text: string) => { amount: string; unit?: number } | null;
  /** { amount, unit } to stored text. */
  write: (amount: string, unit: number) => string;
  defaultUnit?: number;
  /** An empty box means something of its own (such as "Same as run timeout"). */
  emptyLabel?: string;
  disabled?: boolean;
  label?: string;
  testID?: string;
}

/**
 * A number with a unit in one box: "30 minutes", "512 MB". The unit is a part of the box that opens
 * a short list; the number is typed (Up and Down step it). Stored text the units cannot show (such
 * as "500ms") is edited as plain text.
 */
export function SettingQuantity(props: SettingQuantityProps) {
  // equals: false, so a rejected keystroke (a letter) is written back over the field.
  const amount = signal("", { equals: false });
  const unit = signal(untracked(() => props.defaultUnit ?? 1));
  const raw = signal(false);
  const focused = signal(false);
  // The last value this field sent, so its echo through `value` is not applied again.
  let lastSent: string | null = null;

  effect(() => {
    const value = props.value ?? "";
    untracked(() => {
      if (lastSent !== null && value === lastSent) return;
      const parsed = props.read(value);
      batch(() => {
        raw.set(parsed === null);
        if (parsed) {
          amount.set(parsed.amount);
          unit.set(parsed.unit ?? props.defaultUnit ?? 1);
        }
      });
    });
  });

  const unitItem = () => props.units.find((item) => item.value === unit()) || props.units[0];
  // "1 minute", "2 minutes": units carry a singular title when it differs.
  const unitTitle = () => (Number(amount()) === 1 && unitItem()?.one ? unitItem()!.one! : unitItem()?.title ?? "");

  const send = () => {
    lastSent = props.write(String(amount() ?? "").trim(), unit());
    props.onChange?.(lastSent);
  };
  const step = (delta: number) => {
    if (props.disabled) return;
    const number = Number(amount()) || 0;
    amount.set(String(Math.max(0, Math.round((number + delta) * 1000) / 1000)));
    send();
  };
  // Up and Down step the amount while the box has the focus.
  effect(() => {
    if (!focused()) return;
    const off = keymap.bind({ up: () => step(1), down: () => step(-1) }, { when: "always" });
    cleanup(off);
  });

  return (
    <If
      when={!raw()}
      else={
        <View class={boxClass({ disabled: props.disabled })}>
          <Input
            value={props.value}
            readonly={props.disabled}
            accessibilityLabel={props.label || undefined}
            testID={props.testID}
            autoCapitalize="none"
            autoCorrect={false}
            onChange={({ value }) => {
              if (props.disabled) return;
              lastSent = value;
              props.onChange?.(value);
            }}
            class={`${INPUT_CLASS} font-mono`}
          />
        </View>
      }
    >
      <View class={boxClass({ disabled: props.disabled })}>
        <Input
          value={amount()}
          placeholder={props.emptyLabel || undefined}
          readonly={props.disabled}
          keyboardType="decimal-pad"
          accessibilityLabel={props.label ? `${props.label} (${unitItem()?.title ?? ""})` : undefined}
          testID={props.testID}
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          onChange={({ value }) => {
            if (props.disabled) return;
            // Digits and one decimal point only.
            amount.set(value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"));
            send();
          }}
          class={`${INPUT_CLASS} font-mono`}
        />
        <Sep />
        <SettingMenu
          items={props.units.map((item) => ({ title: item.title, value: String(item.value) }))}
          selected={String(unit())}
          align="end"
          label={props.label ? `${props.label} unit` : "Unit"}
          accessibilityLabel={props.label ? `${props.label}: unit, ${unitItem()?.title ?? ""}` : `Unit, ${unitItem()?.title ?? ""}`}
          disabled={props.disabled}
          testID={props.testID ? `${props.testID}-unit` : undefined}
          onSelect={(item) => {
            unit.set(Number(item.value));
            send();
          }}
          trigger={(open) => (
            <View class="flex-row items-center gap-1.5 px-3 hover:bg-hover">
              <Text class="text-sm text-subtle">{unitTitle()}</Text>
              <MenuCaret open={open()} />
            </View>
          )}
        />
      </View>
    </If>
  );
}

const DURATION_UNITS: QuantityUnit[] = [
  { title: "seconds", one: "second", value: 1 },
  { title: "minutes", one: "minute", value: 60 },
  { title: "hours", one: "hour", value: 3600 },
  { title: "days", one: "day", value: 86400 },
];

export interface SettingDurationProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  label?: string;
  /** Zero means something of its own: the box is left empty and says so. */
  zeroLabel?: string;
  testID?: string;
}

/** A Go duration ("1h30m") as an amount and a unit in one box. */
export function SettingDuration(props: SettingDurationProps) {
  const read = (text: string) => {
    const value = String(text ?? "").trim();
    if (value === "") return { amount: "", unit: 60 };
    const seconds = durationSeconds(value);
    if (seconds === null) return null;
    if (seconds === 0) return { amount: props.zeroLabel ? "" : "0", unit: 60 };
    return splitDuration(seconds) as { amount: string; unit: number };
  };
  const write = (amount: string, unit: number) => {
    if (amount === "") return props.zeroLabel ? formatDuration(0) : "";
    const number = Number(amount);
    return Number.isFinite(number) ? formatDuration(number * unit) : amount;
  };
  return (
    <SettingQuantity
      value={props.value}
      onChange={props.onChange}
      units={DURATION_UNITS}
      read={read}
      write={write}
      defaultUnit={60}
      emptyLabel={props.zeroLabel}
      disabled={props.disabled}
      label={props.label}
      testID={props.testID}
    />
  );
}

const BYTE_UNITS: QuantityUnit[] = [
  { title: "bytes", one: "byte", value: 1 },
  { title: "KB", value: 1024 },
  { title: "MB", value: 1024 * 1024 },
  { title: "GB", value: 1024 * 1024 * 1024 },
];

export interface SettingBytesProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  label?: string;
  testID?: string;
}

/** A byte count as an amount and a unit in one box, saved as whole bytes. */
export function SettingBytes(props: SettingBytesProps) {
  const read = (text: string) => {
    const value = String(text ?? "").trim();
    const bytes = Number(value);
    if (value === "") return { amount: "", unit: BYTE_UNITS[2].value };
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    if (bytes === 0) return { amount: "0", unit: BYTE_UNITS[2].value };
    // The largest unit that shows the count as a whole number.
    const unit = [...BYTE_UNITS].reverse().find((item) => bytes % item.value === 0) || BYTE_UNITS[0];
    return { amount: String(bytes / unit.value), unit: unit.value };
  };
  const write = (amount: string, unit: number) => {
    if (amount === "") return "";
    const number = Number(amount);
    return Number.isFinite(number) ? String(Math.round(number * unit)) : amount;
  };
  return (
    <SettingQuantity
      value={props.value}
      onChange={props.onChange}
      units={BYTE_UNITS}
      read={read}
      write={write}
      defaultUnit={1048576}
      disabled={props.disabled}
      label={props.label}
      testID={props.testID}
    />
  );
}

/* ---------- SettingLimit ---------- */

export interface SettingLimitProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  label?: string;
  defaultLimit?: string;
  testID?: string;
}

/**
 * An integer limit where 0 means "no limit", in one box. Limited, it is a number with a "No limit"
 * part; unlimited, the box says so and offers "Set limit", which brings back the last limit.
 */
export function SettingLimit(props: SettingLimitProps) {
  let field: InputRef | undefined;
  const focused = signal(false);
  // Kept apart from the value so clearing the box while typing does not drop the limit.
  const limited = signal(false);
  const lastLimit = signal(untracked(() => props.defaultLimit ?? ""));
  // Bumped to write a rejected keystroke back over the field.
  const echo = signal(0);

  effect(() => {
    const text = String(props.value ?? "").trim();
    untracked(() => {
      if (text === "0") limited.set(false);
      else if (text !== "") {
        batch(() => {
          limited.set(true);
          lastLimit.set(text);
        });
      }
    });
  });

  // 200000 reads as "200,000" until the box is edited.
  const shown = () => {
    echo();
    const text = String(props.value ?? "").trim();
    if (focused() || !/^\d+$/.test(text)) return text;
    return Number(text).toLocaleString();
  };

  const setLimited = (on: boolean) => {
    if (props.disabled) return;
    limited.set(on);
    props.onChange?.(on ? lastLimit() || props.defaultLimit || "1" : "0");
    if (on) {
      queueMicrotask(() => {
        field?.focus();
        const length = String(props.value ?? "").length;
        field?.setSelection(0, length);
      });
    }
  };

  return (
    <View class={boxClass({ disabled: props.disabled })}>
      <If
        when={limited()}
        else={
          <>
            <BaseButton
              disabled={props.disabled}
              onPress={() => setLimited(true)}
              accessibilityLabel={props.label ? t("settings_limit_none_named", { name: props.label }) : t("settings_limit_none_action")}
              testID={props.testID}
              class="flex-1 flex-row items-center px-3 py-2 hover:bg-hover"
            >
              <Text class="text-sm text-muted-foreground">{t("settings_limit_none")}</Text>
            </BaseButton>
            <Sep />
            <Part label={t("settings_limit_set")} disabled={props.disabled} onPress={() => setLimited(true)} />
          </>
        }
      >
        <Input
          ref={field}
          value={shown()}
          readonly={props.disabled}
          keyboardType="number-pad"
          accessibilityLabel={props.label || undefined}
          testID={props.testID}
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          onChange={({ value }) => {
            if (props.disabled) return;
            const cleaned = value.replace(/\D/g, "");
            if (cleaned !== value) echo.update((n) => n + 1);
            props.onChange?.(cleaned);
          }}
          class={`${INPUT_CLASS} font-mono`}
        />
        <Sep />
        <Part label={t("settings_limit_none")} quiet disabled={props.disabled} onPress={() => setLimited(false)} />
      </If>
    </View>
  );
}

/* ---------- SettingPath ---------- */

export interface SettingPathProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  testID?: string;
}

/**
 * A folder path in one box, with Browse at its end. Browse only shows in the desktop app while
 * editing this machine's settings, where a picked folder is a path the backend can use.
 */
export function SettingPath(props: SettingPathProps) {
  const canBrowse = SettingsCanBrowsePaths();
  const browsing = signal(false);
  const error = signal("");

  const browse = async () => {
    if (props.disabled || browsing()) return;
    browsing.set(true);
    error.set("");
    try {
      const picked = await pickDesktopDirectory({ title: props.label, current: props.value });
      if (picked) props.onChange?.(picked);
    } catch (e: any) {
      console.warn("[SettingPath] folder picker failed", e);
      error.set(e?.message || "Could not open the folder picker.");
    } finally {
      browsing.set(false);
    }
  };

  return (
    <View class="gap-1">
      <View class={boxClass({ disabled: props.disabled })}>
        <Input
          value={props.value}
          placeholder={props.placeholder || undefined}
          readonly={props.disabled}
          accessibilityLabel={props.label || undefined}
          testID={props.testID}
          autoCapitalize="none"
          autoCorrect={false}
          onChange={({ value }) => props.onChange?.(value)}
          class={`${INPUT_CLASS} font-mono`}
        />
        <If when={canBrowse()}>
          <Sep />
          <Part
            icon="PhFolderOpen"
            label={browsing() ? "Opening…" : "Browse"}
            disabled={props.disabled || browsing()}
            onPress={() => void browse()}
          />
        </If>
      </View>
      <If when={error()}>
        <Text class="text-xs text-danger">{error()}</Text>
      </If>
    </View>
  );
}

/* ---------- SettingPercent ---------- */

export interface SettingPercentProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  label?: string;
  testID?: string;
}

/** The least width of a fader's fill, so its handle shows at 0 too. */
const FADER_MIN_FILL = 22;

/**
 * A 0–1 ratio as a fader: one bar that fills to the value, a handle at the fill's edge and the
 * value read out inside the bar's far end. A ratio is a position on a scale, so there is nothing
 * to type: drag, press the bar, or use the arrow keys.
 *
 * The Slider takes the presses, the drags, the keys and the screen reader: it is the bar's own
 * content, with clear parts, and gives the bar its height. The fill and the value are drawn from
 * the value behind it and take no presses. Both span the bar's whole width, so the fill's edge is
 * where the finger is.
 */
export function SettingPercent(props: SettingPercentProps) {
  const percent = () => {
    const text = String(props.value ?? "").trim();
    const ratio = Number(text);
    if (text === "" || !Number.isFinite(ratio)) return null;
    return Math.min(100, Math.max(0, Math.round(ratio * 100)));
  };
  const update = (value: number) => {
    if (props.disabled) return;
    const number = Math.min(100, Math.max(0, Math.round(Number(value))));
    props.onChange?.(String(number / 100));
  };
  return (
    <View class={`w-full overflow-hidden ${CONTROL_CORNERS} border border-input bg-muted transition-colors duration-120 ${props.disabled ? "opacity-50" : "hover:border-ink/32"}`}>
      <View
        class={`absolute inset-y-0 left-0 ${CONTROL_CORNERS} bg-foreground/12`}
        style={{ width: `${percent() ?? 0}%`, minWidth: FADER_MIN_FILL, pointerEvents: "none" }}
        accessibilityElementsHidden
        testID={props.testID ? `${props.testID}-fill` : undefined}
      >
        <View class="absolute inset-y-0 right-2 justify-center">
          <View class="h-5 w-1.5 rounded-full bg-foreground/40" />
        </View>
      </View>
      <View class="absolute inset-y-0 right-4 flex-row items-center" style={{ pointerEvents: "none" }} accessibilityElementsHidden>
        <If when={percent() !== null} else={<Text class="font-mono text-base text-muted-foreground">—</Text>}>
          <Text class="font-mono text-base font-semibold tabular-nums text-foreground">{String(percent())}</Text>
          <Text class="ml-px font-mono text-xs text-muted-foreground">%</Text>
        </If>
      </View>
      <Slider
        value={percent() ?? 0}
        min={0}
        max={100}
        step={1}
        disabled={props.disabled}
        accessibilityLabel={props.label || undefined}
        testID={props.testID}
        onChange={({ value }) => update(Array.isArray(value) ? value[0] : value)}
        trackClass="h-11 justify-center"
        indicatorClass="h-11 bg-transparent"
        rangeClass="bg-transparent"
        thumbClass={`h-11 w-6 ${CONTROL_CORNERS} bg-transparent focus-visible:bg-foreground/10`}
      />
    </View>
  );
}

/* ---------- SettingChoices ---------- */

export interface SettingChoicesProps {
  value: string[];
  onChange?: (value: string[]) => void;
  options: string[];
  disabled?: boolean;
  /** Values whose toggle is locked in its current state. */
  disabledOptions?: string[];
  label?: string;
  testID?: string;
}

/**
 * Several values from a known list, as toggles laid out like chips. Values already stored that are
 * not in the list still show, so they can be turned off.
 */
export function SettingChoices(props: SettingChoicesProps) {
  const items = () => [...new Set([...(props.options || []), ...(props.value || [])])];
  const on = (item: string) => (props.value || []).includes(item);
  const locked = (item: string) => Boolean(props.disabled || (props.disabledOptions || []).includes(item));
  const toggle = (item: string) => {
    if (locked(item)) return;
    const current = props.value || [];
    props.onChange?.(on(item) ? current.filter((value) => value !== item) : [...new Set([...current, item])]);
  };
  return (
    <View class="flex-row flex-wrap gap-1.5" accessibilityLabel={props.label || undefined} testID={props.testID}>
      <Each of={items()}>
        {(item) => (
          <Toggle
            pressed={on(item())}
            disabled={locked(item())}
            onChange={() => toggle(item())}
            accessibilityLabel={item()}
            class={`min-h-8 flex-row items-center gap-1.5 ${CONTROL_CORNERS} border px-2.5 disabled:opacity-50 ${
              on(item()) ? "border-blue bg-selection" : "border-input bg-field hover:border-ring"
            }`}
          >
            <If when={on(item())}>
              <Icon name="PhCheck" size={12} color="blue" />
            </If>
            <Text class={`text-sm ${on(item()) ? "text-ink" : "text-subtle"}`}>{item()}</Text>
          </Toggle>
        )}
      </Each>
    </View>
  );
}

/* ---------- SettingRows ---------- */

export type SettingRowsMode = "list" | "map" | "env" | "patterns" | "identities";

export interface SettingRowsProps {
  value: string;
  onChange?: (value: string) => void;
  mode?: SettingRowsMode;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  addLabel?: string;
  /** identities mode: [{ title, value, placeholder }]. */
  platforms?: SettingOption[];
  /** Shown instead of the rows when the stored text is JSON the rows cannot show (the Vue `fallback` slot). */
  fallback?: JSX.Element;
  testID?: string;
}

type Row = Record<string, string> & { _id: string };
interface RowColumn {
  key: string;
  placeholder?: string;
  secret?: boolean;
  mono?: boolean;
  select?: boolean;
}

let rowSeq = 0;

/**
 * Lists and maps edited as rows. Each row is one box: its values are parts of that box, split by a
 * hairline, and removing the row is the last part. Rows read and write the same draft text the
 * panel stores (lib/core/setting-rows.js).
 */
export function SettingRows(props: SettingRowsProps) {
  const spec = () => (ROW_MODES as any)[props.mode || "list"] || ROW_MODES.list;
  const columns = (): RowColumn[] => spec().columns;
  const rows = signal<Row[]>([]);
  // JSON the rows cannot show is left to the fallback editor instead of being dropped.
  const unreadable = signal(false);
  // The row whose first input takes the focus once it is made (a row just added).
  let focusRow = "";

  const withIds = (list: Record<string, string>[]): Row[] => list.map((row) => ({ ...row, _id: `row-${++rowSeq}` }));
  const serialize = (list: Row[]) => spec().serialize(list);

  effect(() => {
    const value = props.value ?? "";
    const mode = spec();
    untracked(() => {
      if (value === mode.serialize(rows())) return;
      const parsed = mode.parse(value, props.platforms || []);
      const bad = parsed === null || parsed === undefined;
      batch(() => {
        unreadable.set(bad);
        rows.set(bad ? [] : withIds(parsed));
      });
    });
  });

  const emitRows = (list: Row[]) => props.onChange?.(serialize(list));

  const updateCell = (id: string, key: string, value: string) => {
    if (props.disabled) return;
    const next = rows().map((row) => (row._id === id ? { ...row, [key]: String(value ?? "") } : row));
    rows.set(next);
    emitRows(next);
  };
  const blankRow = (): Row => {
    const row: Record<string, string> = {};
    for (const column of columns()) {
      row[column.key] = column.select ? props.platforms?.[0]?.value || "" : "";
    }
    return { ...row, _id: `row-${++rowSeq}` } as Row;
  };
  const addRow = () => {
    if (props.disabled) return;
    const row = blankRow();
    focusRow = row._id;
    rows.update((list) => [...list, row]);
  };
  const removeRow = (id: string) => {
    if (props.disabled) return;
    const next = rows().filter((row) => row._id !== id);
    rows.set(next);
    emitRows(next);
  };
  const platformItem = (value: string): SettingOption =>
    (props.platforms || []).find((item) => item.value === value) || { title: value || "Other", value };
  const cellPlaceholder = (row: Row, column: RowColumn) => {
    if (props.mode === "identities") return platformItem(row.platform).placeholder || "";
    return column.placeholder || props.placeholder || "";
  };
  const rowError = (row: Row): string => (spec().rowError ? spec().rowError(row) : "");
  const prefix = () => (props.label ? `${props.label}: ` : "");

  return (
    <View class="gap-1.5" accessibilityLabel={props.label || undefined} testID={props.testID}>
      <If when={!unreadable()} else={<>{props.fallback}</>}>
        <Each of={rows()} key={(row) => row._id}>
          {(row, index) => (
            <View class="gap-1">
              <View class={boxClass({ disabled: props.disabled, invalid: Boolean(rowError(row())) })}>
                <Each of={columns()} key={(column) => column.key}>
                  {(column, columnIndex) => (
                    <>
                      <If when={columnIndex() > 0}>
                        <Sep />
                      </If>
                      <If
                        when={column().select}
                        else={
                          <Input
                            ref={(node: InputRef) => {
                              if (columnIndex() === 0 || (columns()[0]?.select && columnIndex() === 1)) {
                                if (focusRow === row()._id) {
                                  focusRow = "";
                                  queueMicrotask(() => node.focus());
                                }
                              }
                            }}
                            value={row()[column().key] ?? ""}
                            masked={column().secret}
                            placeholder={cellPlaceholder(row(), column()) || undefined}
                            readonly={props.disabled}
                            autoCapitalize="none"
                            autoCorrect={false}
                            accessibilityLabel={`${prefix()}${column().placeholder || column().key} ${index() + 1}`}
                            onChange={({ value }) => updateCell(row()._id, column().key, value)}
                            class={`${INPUT_CLASS} ${
                              column().mono || props.mode === "list" || props.mode === "env" || !props.mode ? "font-mono" : ""
                            }`}
                          />
                        }
                      >
                        <SettingMenu
                          items={props.platforms || []}
                          selected={row()[column().key]}
                          label={props.label ? `${props.label} platform` : "Platform"}
                          accessibilityLabel={`${prefix()}platform, ${platformItem(row()[column().key]).title}`}
                          disabled={props.disabled}
                          onSelect={(item) => updateCell(row()._id, column().key, item.value)}
                          trigger={(open) => (
                            <View class="flex-row items-center gap-1.5 px-3 hover:bg-hover">
                              <Text class="text-sm text-foreground">{platformItem(row()[column().key]).title}</Text>
                              <MenuCaret open={open()} />
                            </View>
                          )}
                        />
                      </If>
                    </>
                  )}
                </Each>
                <Sep />
                <Part
                  icon="PhX"
                  quiet
                  disabled={props.disabled}
                  accessibilityLabel={`Remove row ${index() + 1}`}
                  onPress={() => removeRow(row()._id)}
                />
              </View>
              <If when={rowError(row())}>
                <Text class="text-xs text-danger">{rowError(row())}</Text>
              </If>
            </View>
          )}
        </Each>
        <TipButton
          disabled={props.disabled}
          onPress={addRow}
          accessibilityLabel={props.addLabel || "Add"}
          tooltip={<Tip text={props.addLabel || "Add"} />}
          class={`size-8 items-center justify-center self-start ${CONTROL_CORNERS} hover:bg-hover active:bg-selection disabled:opacity-50`}
        >
          <Icon name="PhPlus" size={14} color="blue" />
        </TipButton>
      </If>
    </View>
  );
}
