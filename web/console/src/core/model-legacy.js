// Automatic rules that send a model to the picker's "Others" group, using only the model list:
// names, and dates when the provider gives them.
//
// 1. Not a chat model (embeddings, speech, images, ...).
// 2. A newer version of the same family is listed ("claude-sonnet-5" when "claude-sonnet-5-5" is).
// 3. Published more than a year before the newest model from the same vendor.

const NOT_CHAT = /(embed|whisper|transcrib|(^|[-_])tts($|[-_])|dall-e|(^|[-_])image|imagen|(^|[-_])veo|sora|lyria|moderation|realtime|(^|[-_])audio|(^|[-_])live($|[-_])|robotics|gemini-omni|davinci|babbage)/;

const STAGE_WORDS = new Set(["preview", "latest", "exp", "experimental", "beta"]);

const LEGACY_AGE_SECONDS = 365 * 24 * 60 * 60;

function modelName(id) {
  const text = String(id || "").trim().toLowerCase();
  const slash = text.lastIndexOf("/");
  return slash >= 0 ? text.slice(slash + 1) : text;
}

export function modelVendor(id) {
  const text = String(id || "").trim().toLowerCase();
  const slash = text.indexOf("/");
  return slash > 0 ? text.slice(0, slash) : "";
}

export function isChatModel(id) {
  return !NOT_CHAT.test(modelName(id));
}

// parseModelID splits a model ID into its family (the words, in order, with "*" where versions
// were), its version numbers, and a snapshot date, so versions of one family can be compared.
export function parseModelID(id) {
  const tokens = modelName(id).split(/[-_.:@\s]+/).filter(Boolean);
  const words = [];
  const version = [];
  let date = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d{8}$/.test(token)) {
      date = token;
      continue;
    }
    // 2024-08-06 split into three tokens.
    if (/^20\d{2}$/.test(token) && /^\d{2}$/.test(tokens[i + 1] || "") && /^\d{2}$/.test(tokens[i + 2] || "")) {
      date = token + tokens[i + 1] + tokens[i + 2];
      i += 2;
      continue;
    }
    // A four-digit build such as 0613 or 1106 after the version.
    if (/^[01]\d{3}$/.test(token) && version.length > 0) {
      date = date || token;
      continue;
    }
    if (/^\d{1,2}$/.test(token)) {
      version.push(Number(token));
      if (words[words.length - 1] !== "*") words.push("*");
      continue;
    }
    // Sizes and context lengths (70b, 8x7b, 128k) name a variant, so they belong to the family.
    if (/^\d+(\.\d+)?[bkm]$/.test(token) || /^\d+x\d+[bkm]$/.test(token)) {
      words.push(token);
      continue;
    }
    // A word with a version stuck to it: k3, o3, qwen3, 4o.
    const glued = token.match(/^([a-z]+)(\d{1,2})$/) || token.match(/^(\d{1,2})([a-z]+)$/);
    if (glued) {
      const [word, number] = /^\d/.test(glued[1]) ? [glued[2], glued[1]] : [glued[1], glued[2]];
      version.push(Number(number));
      words.push(word + "*");
      continue;
    }
    if (STAGE_WORDS.has(token)) {
      continue;
    }
    words.push(token);
  }
  // Older and newer naming put the tier before or after the version ("claude-3-5-sonnet",
  // "claude-sonnet-5"), so the family compares its words regardless of order.
  const family = words.filter((word) => word !== "*").sort().join(" ");
  return { family, version, date };
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

// legacyReasons returns, for each model ID that should go to Others, why: { kind: "not_chat" },
// { kind: "superseded", by: id }, or { kind: "old" }. items are { value, created }.
export function legacyReasons(items) {
  const list = (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.value || ""),
    created: Number(item?.created) || 0,
    parsed: parseModelID(item?.value),
    vendor: modelVendor(item?.value),
  })).filter((item) => item.id);
  const reasons = new Map();
  for (const item of list) {
    if (!isChatModel(item.id)) {
      reasons.set(item.id, { kind: "not_chat" });
    }
  }
  const chat = list.filter((item) => !reasons.has(item.id));

  // Newest member of each family.
  const newest = new Map();
  for (const item of chat) {
    if (!item.parsed.family || item.parsed.version.length === 0) continue;
    const key = item.vendor + "\n" + item.parsed.family;
    const best = newest.get(key);
    if (
      !best ||
      compareVersions(item.parsed.version, best.parsed.version) > 0 ||
      (compareVersions(item.parsed.version, best.parsed.version) === 0 && item.parsed.date > best.parsed.date)
    ) {
      newest.set(key, item);
    }
  }
  for (const item of chat) {
    const best = newest.get(item.vendor + "\n" + item.parsed.family);
    if (!best || best === item) continue;
    const cmp = compareVersions(item.parsed.version, best.parsed.version);
    if (cmp < 0 || (cmp === 0 && item.parsed.date && best.parsed.date && item.parsed.date < best.parsed.date)) {
      reasons.set(item.id, { kind: "superseded", by: best.id });
    }
  }

  // Age, against the newest dated model from the same vendor.
  const latestByVendor = new Map();
  for (const item of chat) {
    if (item.created > 0) {
      latestByVendor.set(item.vendor, Math.max(latestByVendor.get(item.vendor) || 0, item.created));
    }
  }
  for (const item of chat) {
    const latest = latestByVendor.get(item.vendor) || 0;
    if (!reasons.has(item.id) && item.created > 0 && latest - item.created > LEGACY_AGE_SECONDS) {
      reasons.set(item.id, { kind: "old" });
    }
  }
  return reasons;
}
