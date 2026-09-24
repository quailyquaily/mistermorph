export function parseLogLine(raw) {
  const line = String(raw ?? "");
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Runtime logs can also contain plain text from subprocesses.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
  const level = typeof parsed.level === "string" ? parsed.level.trim().toLowerCase() : "";
  return {
    line,
    level: level === "warning" ? "warn" : level,
    time: typeof parsed.time === "string" ? parsed.time : "",
    event: typeof parsed.msg === "string" ? parsed.msg : "",
    msg: typeof parsed.msg === "string" && parsed.msg ? parsed.msg : line,
    fields: Object.entries(parsed)
      .filter(([key]) => !["level", "time", "msg"].includes(key))
      .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value, null, 2)]),
  };
}

export function filterLogEntries(entries, query, level, { event = "", since = null } = {}) {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) =>
    (!level || (level === "issues" ? ["warn", "error"].includes(entry.level) : entry.level === level)) &&
    (!event || entry.event === event) &&
    (since === null || Date.parse(entry.time) >= since) &&
    (!needle || entry.line.toLowerCase().includes(needle)));
}

export function logSnapshotKey(payload) {
  return JSON.stringify([payload?.file || "", payload?.size_bytes || 0, Array.isArray(payload?.items) ? payload.items : []]);
}

export function logFieldPreview(fields, max = 8) {
  return fields.slice(0, max).map(([key, value]) => {
    let flat = String(value);
    if (/^[[{]/.test(flat)) {
      try {
        flat = JSON.stringify(JSON.parse(flat));
      } catch {
        // Keep strings that only look like JSON.
      }
    }
    flat = flat.replace(/\s+/g, " ").trim();
    return [key, flat.length > 120 ? `${flat.slice(0, 119)}…` : flat];
  });
}

function validDate(time) {
  const d = new Date(time || "");
  return Number.isNaN(d.getTime()) ? null : d;
}

export function logClock(time, locale) {
  const d = validDate(time);
  if (!d) return "";
  return d.toLocaleTimeString(locale, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
}

export function logDayKey(time) {
  const d = validDate(time);
  return d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : "";
}

export function logDayLabel(time, locale) {
  const d = validDate(time);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${d.toLocaleDateString(locale, { weekday: "short" })}`;
}
