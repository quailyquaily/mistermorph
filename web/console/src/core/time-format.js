function sameDay(left, right) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

// Compact timestamp for lists and "updated" lines: time only for today, month/day and time within
// the current year, date only for older values. Pair it with the full timestamp in a tooltip.
export function formatShortTimestamp(ts, locale, now = new Date()) {
  if (!ts) {
    return "-";
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return String(ts);
  }
  if (sameDay(d, now)) {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}
