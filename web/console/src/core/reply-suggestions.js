// Suggested replies for the latest finished answer (console.reply_suggestions): the top reply as
// composer ghost text on desktop when it clears min_probability, and the likely replies as chips
// on phones, which have no Tab key.

// Chips show replies at or above this probability; the ghost text uses the configured bar.
export const REPLY_CHIP_MIN_PROBABILITY = 0.2;

// latestAnswerTaskID is the task of the last history item when that item is a finished answer that
// is not waiting on an approval; otherwise "".
export function latestAnswerTaskID(items) {
  const list = Array.isArray(items) ? items : [];
  const last = list[list.length - 1];
  if (!last || last.role !== "agent" || String(last.status || "").toLowerCase() !== "done") {
    return "";
  }
  if (String(last?.approval?.status || "").toLowerCase() === "pending") {
    return "";
  }
  return String(last.taskId || "").trim();
}

function normalizeSuggestions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      text: String(item?.text || "").trim(),
      probability: Math.max(0, Math.min(1, Number(item?.probability) || 0)),
    }))
    .filter((item) => item.text)
    .sort((a, b) => b.probability - a.probability);
}

// replySuggestionView decides what the composer offers now.
export function replySuggestionView({ result, taskID, input = "", sending = false, readonly = false, mobile = false, dismissedTaskID = "" }) {
  const none = { ghost: "", chips: [] };
  if (!taskID || !result || result.task_id !== taskID || result.enabled !== true || !result.expects_reply) {
    return none;
  }
  if (String(input || "") !== "" || sending || readonly || dismissedTaskID === taskID) {
    return none;
  }
  const suggestions = normalizeSuggestions(result.suggestions);
  if (mobile) {
    return { ghost: "", chips: suggestions.filter((s) => s.probability >= REPLY_CHIP_MIN_PROBABILITY) };
  }
  const min = Number.isFinite(Number(result.min_probability)) ? Number(result.min_probability) : 0.6;
  const top = suggestions[0];
  return { ghost: top && top.probability >= min ? top.text : "", chips: [] };
}
