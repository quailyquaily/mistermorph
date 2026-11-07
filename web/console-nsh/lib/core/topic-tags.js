// Topic tags: the same rules the server applies (internal/taskdomain/topic_tags.go), so the editor
// shows what will be saved, and the grouping the topic sidebar uses.
//
// "pinned" is a reserved tag: a pinned topic is listed first, above the date groups in the date
// view and in its own group, first, in the tag view. The tag editor shows it as a switch, not a chip.

// The most ordinary tags a topic can have; the pinned tag does not count.
export const MAX_TOPIC_TAGS = 5;
export const MAX_TOPIC_TAG_LENGTH = 32;
export const PINNED_TAG = "pinned";

// Trims a tag and folds its inner whitespace to single spaces.
export function cleanTopicTag(raw) {
  return String(raw ?? "").trim().split(/\s+/u).filter(Boolean).join(" ");
}

function tagKey(tag) {
  return cleanTopicTag(tag).toLocaleLowerCase();
}

export function isPinnedTag(tag) {
  return tagKey(tag) === PINNED_TAG;
}

// Adds tags to a list, keeping the first spelling of tags that differ only in case. Tags longer
// than the limit are cut, as the editor's input already caps them.
export function mergeTopicTags(current, additions) {
  const out = [];
  const seen = new Set();
  for (const raw of [...current, ...additions]) {
    let tag = [...cleanTopicTag(raw)].slice(0, MAX_TOPIC_TAG_LENGTH).join("");
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    if (key === PINNED_TAG) tag = PINNED_TAG;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

// All of a topic's tags, the pinned tag included, cleaned and deduplicated.
export function topicTags(topic) {
  return mergeTopicTags([], Array.isArray(topic?.tags) ? topic.tags : []);
}

// The tags a person gave the topic: everything but the pinned tag.
export function ordinaryTopicTags(topic) {
  return topicTags(topic).filter((tag) => !isPinnedTag(tag));
}

export function topicPinned(topic) {
  return topicTags(topic).some(isPinnedTag);
}

// The full tag list for a topic with these ordinary tags and this pin state; the pin goes first.
export function withPinned(ordinaryTags, pinned) {
  const tags = mergeTopicTags([], ordinaryTags).filter((tag) => !isPinnedTag(tag));
  return pinned ? [PINNED_TAG, ...tags] : tags;
}

// Splits typed text into tags at commas (ASCII and full-width).
export function parseTopicTagInput(text) {
  return String(text ?? "").split(/[,，、]/u).map(cleanTopicTag).filter(Boolean);
}

export function sameTopicTags(a, b) {
  const left = topicTags({ tags: a });
  const right = topicTags({ tags: b });
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function compareTags(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

// Every ordinary tag used by the topics, once, in sorted order; the first spelling seen wins.
export function knownTopicTags(topics) {
  const byKey = new Map();
  for (const topic of topics || []) {
    for (const tag of ordinaryTopicTags(topic)) {
      const key = tagKey(tag);
      if (!byKey.has(key)) byKey.set(key, tag);
    }
  }
  return [...byKey.values()].sort(compareTags);
}

// Suggestions for what has been typed: tags starting with it first, then tags containing it, each
// in sorted order. Tags already on the topic are left out.
export function suggestTopicTags(known, applied, typed, limit = 8) {
  const used = new Set((applied || []).map(tagKey));
  const query = tagKey(typed);
  const starts = [];
  const contains = [];
  for (const tag of known || []) {
    const key = tagKey(tag);
    if (used.has(key) || key === PINNED_TAG) continue;
    if (!query || key.startsWith(query)) starts.push(tag);
    else if (key.includes(query)) contains.push(tag);
  }
  return [...starts, ...contains].slice(0, limit);
}

// Where a dropped topic goes: drop.kind is "pin", "tag" (with drop.tag) or "untagged". Returns the
// topic's new tag list, or null when the drop changes nothing.
export function tagsAfterDrop(topic, drop) {
  const ordinary = ordinaryTopicTags(topic);
  const pinned = topicPinned(topic);
  let next = null;
  if (drop?.kind === "pin") {
    next = withPinned(ordinary, true);
  } else if (drop?.kind === "untagged") {
    next = withPinned([], pinned);
  } else if (drop?.kind === "tag" && cleanTopicTag(drop.tag)) {
    next = withPinned(mergeTopicTags(ordinary, [drop.tag]), pinned);
  }
  if (!next || next.filter((tag) => !isPinnedTag(tag)).length > MAX_TOPIC_TAGS || sameTopicTags(next, topicTags(topic))) return null;
  return next;
}

// The date view puts pinned topics in a group of their own, above the date groups, and leaves them
// out of those.
export function splitPinnedTopics(topics) {
  const pinned = [];
  const rest = [];
  for (const topic of topics || []) {
    (topicPinned(topic) ? pinned : rest).push(topic);
  }
  return { pinned, rest };
}

// The tag view: the pinned group first, then a group per tag in sorted order, then the unpinned
// topics with no ordinary tag. A topic with several tags appears under each. Topics keep their order within a
// group. Each group says what dropping a topic on it does.
export function groupTopicsByTag(topics, labels = {}) {
  const pinnedTopics = [];
  const groups = new Map();
  const untagged = [];
  for (const topic of topics || []) {
    const pinned = topicPinned(topic);
    if (pinned) pinnedTopics.push(topic);
    const tags = ordinaryTopicTags(topic);
    if (tags.length === 0) {
      // A pinned topic is already listed in the pinned group.
      if (!pinned) untagged.push(topic);
      continue;
    }
    for (const tag of tags) {
      const key = tagKey(tag);
      if (!groups.has(key)) groups.set(key, { key: `tag:${key}`, tag, label: tag, topics: [], drop: { kind: "tag", tag } });
      groups.get(key).topics.push(topic);
    }
  }
  const out = [];
  if (pinnedTopics.length > 0) {
    out.push({ key: "pinned", label: labels.pinned || "Pinned", topics: pinnedTopics, pinned: true, drop: { kind: "pin" } });
  }
  out.push(...[...groups.values()].sort((a, b) => compareTags(a.tag, b.tag)));
  if (untagged.length > 0) {
    out.push({ key: "tag:", label: labels.untagged || "Untagged", topics: untagged, untagged: true, drop: { kind: "untagged" } });
  }
  return out;
}
