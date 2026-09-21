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
    msg: typeof parsed.msg === "string" && parsed.msg ? parsed.msg : line,
    fields: Object.entries(parsed)
      .filter(([key]) => !["level", "time", "msg"].includes(key))
      .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value, null, 2)]),
  };
}

export function filterLogEntries(entries, query, level) {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => (!level || entry.level === level) && (!needle || entry.line.toLowerCase().includes(needle)));
}

export function logSnapshotKey(payload) {
  return JSON.stringify([payload?.file || "", payload?.size_bytes || 0, Array.isArray(payload?.items) ? payload.items : []]);
}
