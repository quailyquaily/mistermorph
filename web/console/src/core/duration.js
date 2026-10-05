// Go duration text ("1h30m", "90s", "720h") to and from an amount and a unit for editing.

export const DURATION_UNITS = [
  { title: "seconds", value: 1 },
  { title: "minutes", value: 60 },
  { title: "hours", value: 3600 },
  { title: "days", value: 86400 },
];

const PART = /(\d+(?:\.\d+)?)(h|m|s)/g;
const UNIT_SECONDS = { h: 3600, m: 60, s: 1 };

// Total seconds of a Go duration made of h/m/s parts, or null when the text is anything else
// (such as "500ms"), which the editor then leaves as raw text.
export function durationSeconds(text) {
  const value = String(text ?? "").trim();
  if (value === "") return null;
  if (value === "0") return 0;
  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(PART)) {
    if (match.index !== consumed) return null;
    total += Number(match[1]) * UNIT_SECONDS[match[2]];
    consumed += match[0].length;
  }
  return consumed === value.length ? total : null;
}

// Go duration text for whole seconds, in the same compact form the settings panel shows
// ("1h30m", "1m30s", "720h"), so an unchanged value reads the same after a round trip.
export function formatDuration(seconds) {
  let rest = Math.round(Number(seconds));
  if (!Number.isFinite(rest) || rest < 0) return "";
  if (rest === 0) return "0s";
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  rest -= minutes * 60;
  return `${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}${rest ? `${rest}s` : ""}`;
}

// The largest unit that shows the duration as a whole number.
export function splitDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return { amount: "", unit: 60 };
  const unit = [...DURATION_UNITS].reverse().find((item) => total % item.value === 0) || DURATION_UNITS[0];
  return { amount: String(total / unit.value), unit: unit.value };
}
