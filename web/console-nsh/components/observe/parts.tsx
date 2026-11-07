// Small pieces the Stats, Audit and Logs pages share: hover hints, number formats, a segmented
// choice row, and the badge weights the audit ledger uses.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton, Tooltip } from "nsh/base";
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
  return (
    <Tooltip class="max-w-xs bg-foreground px-2 py-1">
      <Text class="text-xs text-background tabular-nums">{value}</Text>
    </Tooltip>
  );
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

/** The audit ledger's badge: quiet outlined grey, outlined in its tone when notable, filled when it needs action. */
export type AuditBadgeType = "default" | "warning" | "danger" | "success" | "primary";
export interface AuditBadgeSpec {
  type: AuditBadgeType;
  variant: "filled" | "outlined";
}

export function AuditBadge(props: { badge: AuditBadgeSpec; label: string; testID?: string }) {
  const box = () => {
    const { type, variant } = props.badge;
    if (variant === "filled") {
      if (type === "danger") return { box: "bg-danger border-danger", text: "text-primary-foreground" };
      if (type === "warning") return { box: "bg-warn border-warn", text: "text-primary-foreground" };
      if (type === "success") return { box: "bg-ok border-ok", text: "text-primary-foreground" };
      return { box: "bg-blue border-blue", text: "text-primary-foreground" };
    }
    if (type === "danger") return { box: "border-danger", text: "text-danger" };
    if (type === "warning") return { box: "border-warn", text: "text-warn-dark" };
    if (type === "success") return { box: "border-ok", text: "text-ok" };
    return { box: "border-line", text: "text-subtle" };
  };
  return (
    <View class={`self-start rounded-(--radius) border px-1.5 py-px ${box().box}`} testID={props.testID}>
      <Text class={`text-xs ${box().text}`}>{props.label}</Text>
    </View>
  );
}
