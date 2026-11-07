// Compact money for dashboards: two decimals from 1 up, four from 0.01, two significant digits
// below that. Pair it with the exact value in a tooltip.
export function formatCompactCost(value, currency = "USD", locale = undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "-";
  }
  const code = String(currency || "USD").toUpperCase();
  const abs = Math.abs(n);
  const digits =
    abs === 0 || abs >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : abs >= 0.01
        ? { minimumFractionDigits: 4, maximumFractionDigits: 4 }
        : { minimumSignificantDigits: 2, maximumSignificantDigits: 2 };
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code, ...digits }).format(n);
  } catch {
    return `${code} ${abs >= 0.01 || abs === 0 ? n.toFixed(abs >= 1 || abs === 0 ? 2 : 4) : n.toPrecision(2)}`;
  }
}

// The exact value, for tooltips.
export function formatExactCost(value, currency = "USD", locale = undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  const code = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n);
  } catch {
    return `${code} ${n.toFixed(6)}`;
  }
}
