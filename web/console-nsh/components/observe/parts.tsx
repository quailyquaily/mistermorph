// Small pieces the Stats, Audit and Logs pages share: hover hints, number formats, a segmented
// choice row, and the badge weights the audit ledger uses.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Tip } from "../ui";
import { currentLocale, translate } from "../../lib/core/context.js";
import { formatCompactCost, formatExactCost } from "../../lib/core/cost-format.js";
import { formatNumber as intlNumber } from "../../lib/core/intl-format.js";

/** The console's strings (lib/i18n), typed for TSX: `t("stats_title")`, `t("x", { count })`. */
export const t = translate as unknown as (key: string, vars?: Record<string, unknown>) => string;

/** The Vue console's compact money ("$53.58"), in the current locale. */
export function compactCost(value: unknown, currency = "USD"): string {
  return (formatCompactCost as any)(value, currency, currentLocale());
}

/** The exact money, for hints. */
export function exactCost(value: unknown, currency = "USD"): string {
  return (formatExactCost as any)(value, currency, currentLocale());
}

/** Intl number formatting with a cached formatter. */
export function formatIntl(value: number, options?: Intl.NumberFormatOptions): string {
  return (intlNumber as any)(value, currentLocale(), options);
}

/** A hover hint for an element's `tooltip` prop; nothing when the text is empty (the Vue `title`). */
export function hint(text: string | undefined | null): JSX.Element | undefined {
  const value = String(text ?? "").trim();
  if (!value) return undefined;
  return <Tip text={value} />;
}

/** A whole number with the locale's grouping ("8,404"), "0" for anything not finite. */
export function wholeNumber(value: unknown): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return formatIntl(Math.trunc(n));
}

/** A share 0..1 as "42.5%", "-" when unknown. */
export function percentOne(value: unknown): string {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return "-";
  const clamped = Math.min(Math.max(n, 0), 1);
  return formatIntl(clamped, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A share 0..1 as "42%", "-" when unknown. */
export function percentWhole(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return formatIntl(n, { style: "percent", maximumFractionDigits: 0 });
}

/** "1.2K", "601.73M". */
export function compactNumber(value: unknown): string {
  return formatIntl(Number(value) || 0, { notation: "compact", maximumFractionDigits: 2 });
}

/** The exact integer with grouping, for hints. */
export function exactNumber(value: unknown): string {
  return formatIntl(Math.trunc(Number(value) || 0));
}

export interface SegmentItem<V extends string | number> {
  id: V;
  label: string;
}

/**
 * A row of mutually exclusive choices (the Vue console's AppTabs used as a segmented control):
 * the current one marked. Each choice is a button with `testID` `${testID}-${id}`.
 */
export function Segmented<V extends string | number>(props: {
  items: SegmentItem<V>[];
  value: V;
  onChange?: (id: V) => void;
  label?: string;
  testID?: string;
  class?: string;
}) {
  return (
    <View class={`flex-row flex-wrap gap-1 ${props.class ?? ""}`} role="tablist" accessibilityLabel={props.label}>
      <Each of={props.items} key={(item) => String(item.id)}>
        {(item) => (
          <BaseButton
            role="tab"
            selected={props.value === item().id}
            onPress={() => props.onChange?.(item().id)}
            accessibilityLabel={item().label}
            testID={props.testID ? `${props.testID}-${item().id}` : undefined}
            class="-mb-px border-b-2 border-transparent px-2 py-1 hover:bg-hover selected:border-blue"
          >
            <Text class={`text-sm ${props.value === item().id ? "font-medium text-foreground" : "text-subtle"}`}>{item().label}</Text>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}

/**
 * A titled block in the Vue console's AppSection terms, with a head that takes nodes as its meta
 * (ui.tsx's Section takes a string): one row on a hairline rule, the title a mono caps label, the
 * meta after it, actions at the far end. `boxed` frames it in a hairline on the paper, the head
 * 48 tall and the body padded; plain heads are 44 tall and the body follows `gap` below.
 */
export function ObserveSection(props: {
  title?: string;
  meta?: JSX.Element;
  /** Before the title, on the head's left edge (a back button). */
  lead?: JSX.Element;
  actions?: JSX.Element;
  variant?: "boxed" | "plain";
  /** A boxed body without padding, for a toolbar and a list that run edge to edge. */
  flush?: boolean;
  style?: Record<string, unknown>;
  /** Padding of a boxed head and body (Vue's --app-section-padding, 16). */
  padding?: number;
  /** Space between the head and the body, and between the body's children (16). */
  gap?: number;
  class?: string;
  bodyClass?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  const boxed = () => props.variant === "boxed";
  const pad = () => props.padding ?? 16;
  const gap = () => props.gap ?? 16;
  return (
    <View
      class={`${boxed() ? "rounded-(--radius) border border-line-soft bg-card-soft" : ""} ${props.class ?? ""}`}
      style={{ ...props.style, rowGap: boxed() ? 0 : gap() }}
      testID={props.testID}
    >
      <If when={props.title || props.meta || props.actions || props.lead}>
        <View
          class="flex-row items-center gap-2.5 border-b border-line-soft"
          style={{ height: boxed() ? 48 : 44, paddingLeft: boxed() ? pad() : 0, paddingRight: boxed() ? pad() : 0 }}
        >
          <If when={props.lead}>
            <View class="-ml-2 -mr-1 flex-row items-center">{props.lead}</View>
          </If>
          <If when={props.title}>
            <Text role="header" class="shrink-0 font-mono text-[11px] font-semibold uppercase leading-[15.4px] tracking-[0.1em] text-subtle line-clamp-1">
              {props.title}
            </Text>
          </If>
          <View class="flex-1 flex-row items-baseline overflow-hidden">{props.meta}</View>
          <If when={props.actions}>
            <View class="-mr-1.5 flex-row items-center gap-1">{props.actions}</View>
          </If>
        </View>
      </If>
      <View class={props.bodyClass ?? ""} style={{ rowGap: gap(), padding: boxed() && !props.flush ? pad() : 0 }}>
        {props.children}
      </View>
    </View>
  );
}

/** The audit ledger's badge: quiet outlined grey, outlined in its tone when notable, filled when it needs action. */

export type AuditBadgeType = "default" | "warning" | "danger" | "success" | "primary";
export interface AuditBadgeSpec {
  type: AuditBadgeType;
  variant: "filled" | "outlined";
}

/**
 * The audit ledger's badge, as the morph theme draws Quail's: no box, the label in mono caps
 * weight between bracket marks in the tone's colour ("[ Allow ]"); a filled badge (one that needs
 * action) sits on a tint of its tone.
 */
export function AuditBadge(props: { badge: AuditBadgeSpec; label: string; testID?: string }) {
  const tone = () => {
    switch (props.badge.type) {
      case "danger":
        return { frame: "text-danger", text: "text-danger", fill: "bg-danger/15" };
      case "warning":
        return { frame: "text-warn", text: "text-warn-dark", fill: "bg-warn/15" };
      case "success":
        return { frame: "text-ok", text: "text-ok", fill: "bg-ok/15" };
      case "primary":
        return { frame: "text-blue", text: "text-ink", fill: "bg-blue/15" };
      default:
        return { frame: "text-muted-foreground", text: "text-foreground", fill: "bg-foreground/10" };
    }
  };
  const filled = () => props.badge.variant === "filled";
  return (
    <View class={`flex-row items-baseline self-center py-px ${filled() ? `rounded-(--radius) px-1.5 ${tone().fill}` : ""}`} testID={props.testID}>
      <Text class={`font-mono text-[11px] leading-[14.3px] ${tone().frame}`}>[</Text>
      <Text class={`mx-3 font-mono text-[11px] font-semibold leading-[14.3px] tracking-[0.04em] ${tone().text}`}>{props.label}</Text>
      <Text class={`font-mono text-[11px] leading-[14.3px] ${tone().frame}`}>]</Text>
    </View>
  );
}
