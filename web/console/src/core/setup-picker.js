import { legacyReasons } from "./model-legacy.js";
import { modelNoteFor } from "./model-notes.js";

// Rows for the setup picker dialog: filtering, vendor groups, the custom row, and match highlighting.

export function splitPrefix(value) {
  const text = String(value || "");
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    return { prefix: "", rest: text };
  }
  return { prefix: text.slice(0, slash), rest: text.slice(slash + 1) };
}

// Splits text into parts, marking where it contains needle (case-insensitive), for highlighting.
export function highlightParts(text, needle) {
  const source = String(text || "");
  const query = String(needle || "").trim().toLowerCase();
  if (!query) {
    return [{ text: source, match: false }];
  }
  const lower = source.toLowerCase();
  const parts = [];
  let from = 0;
  for (;;) {
    const index = lower.indexOf(query, from);
    if (index < 0) {
      break;
    }
    if (index > from) {
      parts.push({ text: source.slice(from, index), match: false });
    }
    parts.push({ text: source.slice(index, index + query.length), match: true });
    from = index + query.length;
  }
  if (from < source.length) {
    parts.push({ text: source.slice(from), match: false });
  }
  return parts;
}

// The rows to show: filtered items, grouped by vendor prefix when asked (and when any value has
// one), then the custom row. Each row has an index for keyboard navigation.
export function buildPickerRows(items, { query = "", groupByPrefix = false, allowCustom = false, labels = {} } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const source = Array.isArray(items) ? items : [];
  const filtered = needle
    ? source.filter((item) =>
        [item?.title, item?.value, item?.note].map((value) => String(value || "").toLowerCase()).join("\n").includes(needle)
      )
    : source;
  const grouped = groupByPrefix && filtered.some((item) => splitPrefix(item?.value || item?.title).prefix);
  const groups = [];
  if (grouped) {
    const byPrefix = new Map();
    for (const item of filtered) {
      const { prefix, rest } = splitPrefix(item?.value || item?.title);
      const key = prefix || "";
      if (!byPrefix.has(key)) {
        byPrefix.set(key, { id: key || "other", title: prefix, items: [] });
      }
      byPrefix.get(key).items.push({ item, label: prefix ? rest : String(item?.title || item?.value || "") });
    }
    // Groups keep the order of their first model, so with a newest-first list the vendor with the
    // newest model comes first.
    groups.push(...byPrefix.values());
  } else {
    groups.push({ id: "all", title: "", items: filtered.map((item) => ({ item, label: String(item?.title || "") })) });
  }
  // Models to avoid move out of their group into Others at the bottom.
  const avoided = { id: "avoid", title: String(labels.avoid || "Others"), verdict: "avoid", items: [] };
  for (const group of groups) {
    group.items = group.items.filter((row) => {
      if (row.item?.verdict === "avoid") {
        avoided.items.push(row);
        return false;
      }
      return true;
    });
  }
  if (avoided.items.length) {
    // A plain list gets a "Models" heading so it is set apart from Others.
    for (const group of groups) {
      if (!group.title) {
        group.title = String(labels.other || "Models");
      }
    }
    groups.push(avoided);
  }
  let index = 0;
  for (const group of groups) {
    for (const row of group.items) {
      row.index = index++;
    }
  }
  const typed = String(query || "").trim();
  const exact = source.some((item) => String(item?.value || "") === typed);
  const custom = allowCustom && typed && !exact ? { index: index++, value: typed } : null;
  return { groups: groups.filter((group) => group.items.length > 0), custom, count: index };
}

// Why a model is in Others, by language (as the notes in model-notes.js); English is the fallback.
const LEGACY_REASONS = {
  not_chat: {
    en: "Not a chat model; it won't work here.",
    zh: "不是聊天模型，这里用不了。",
    ja: "チャットモデルではないので、ここでは使えません。",
  },
  superseded: {
    en: "Newer version available: {model}",
    zh: "有新版本了：{model}",
    ja: "新しい版があります：{model}",
  },
  old: {
    en: "Over a year older than this provider's newest model.",
    zh: "比这家最新的模型早一年以上。",
    ja: "このプロバイダーの最新モデルより 1 年以上古いモデルです。",
  },
};

function legacyReasonText(kind, locale, params = {}) {
  const lang = String(locale || "en").toLowerCase().split(/[-_]/)[0];
  const texts = LEGACY_REASONS[kind] || {};
  return String(texts[lang] || texts.en || "").replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

// The model picker's items from a /settings/agent/models response: the dated list, newest first
// (the dates feed the rules, they are not shown); or, from an older runtime, the plain list of names.
// Each item gets its note and verdict: a non-chat model always goes to Others; otherwise an entry
// in model-notes.js decides, and without one the automatic rules (model-legacy.js) do.
export function modelPickerItemsFromPayload(payload, locale = "en") {
  let items;
  const dated = Array.isArray(payload?.models) ? payload.models : null;
  if (dated) {
    items = dated
      .map((model) => {
        const value = String(model?.id || "").trim();
        return { id: value, title: value, value, note: "", created: Number(model?.created) || 0 };
      })
      .filter((item) => item.value !== "");
  } else {
    const names = Array.isArray(payload?.items) ? payload.items : [];
    items = names.map((value) => ({ id: value, title: value, value, note: "" }));
  }
  const reasons = legacyReasons(items);
  return items.map((item) => {
    const reason = reasons.get(item.value);
    const found = modelNoteFor(item.value, locale);
    if (reason?.kind === "not_chat") {
      return { ...item, verdict: "avoid", note: legacyReasonText("not_chat", locale) };
    }
    if (found) {
      return { ...item, verdict: found.verdict, note: found.note || item.note };
    }
    if (reason?.kind === "superseded") {
      const by = reason.by.slice(reason.by.lastIndexOf("/") + 1);
      return { ...item, verdict: "avoid", note: legacyReasonText("superseded", locale, { model: by }) };
    }
    if (reason?.kind === "old") {
      return { ...item, verdict: "avoid", note: legacyReasonText("old", locale) };
    }
    return item;
  });
}
