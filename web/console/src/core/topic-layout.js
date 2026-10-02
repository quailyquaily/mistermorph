// The topic list's tag view, as a person arranged it (GET/PUT /topics/layout): the order of the tag
// groups, and of the topics within a tag group or the pinned group. What the layout does not
// mention keeps its default place: a new tag group goes after the arranged ones, and a topic new to
// a group goes first.

export const EMPTY_TOPIC_LAYOUT = Object.freeze({ tag_order: [], topic_order: {} });

export function normalizeTopicLayout(raw) {
  const tagOrder = Array.isArray(raw?.tag_order) ? raw.tag_order.map(String) : [];
  const topicOrder = {};
  for (const [group, ids] of Object.entries(raw?.topic_order || {})) {
    if (Array.isArray(ids)) topicOrder[group] = ids.map(String);
  }
  return { tag_order: tagOrder, topic_order: topicOrder };
}

// Only tag groups move; the pinned group stays first and the untagged group last.
export function isMovableTagGroup(group) {
  return Boolean(group && !group.pinned && !group.untagged && String(group.key || "").startsWith("tag:"));
}

function topicID(topic) {
  return String(topic?.id || "").trim();
}

// Orders a group's topics: those the layout does not list first, as they came, then the listed ones.
export function orderGroupTopics(topics, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return topics;
  const rank = new Map(ids.map((id, index) => [id, index]));
  const unlisted = topics.filter((topic) => !rank.has(topicID(topic)));
  const listed = topics.filter((topic) => rank.has(topicID(topic))).sort((a, b) => rank.get(topicID(a)) - rank.get(topicID(b)));
  return [...unlisted, ...listed];
}

// Applies a layout to groups as groupTopicsByTag returns them.
export function arrangeTopicGroups(groups, layout) {
  const { tag_order: tagOrder, topic_order: topicOrder } = normalizeTopicLayout(layout);
  const rank = new Map(tagOrder.map((key, index) => [key, index]));
  const movable = groups.filter(isMovableTagGroup);
  const arranged = [
    ...movable.filter((group) => rank.has(group.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key)),
    ...movable.filter((group) => !rank.has(group.key)),
  ];
  let next = 0;
  return groups
    .map((group) => (isMovableTagGroup(group) ? arranged[next++] : group))
    .map((group) => {
      const ids = topicOrder[group.key];
      return ids ? { ...group, topics: orderGroupTopics(group.topics, ids) } : group;
    });
}

// Moves item before or after target in list; a missing target puts it at the end.
function moveInList(list, item, target, after) {
  const out = list.filter((entry) => entry !== item);
  let index = target ? out.indexOf(target) : -1;
  if (index < 0) index = out.length;
  else if (after) index += 1;
  out.splice(index, 0, item);
  return out;
}

// Keeps entries the person arranged that are not on screen now (topics not loaded yet, tags of
// unloaded topics), after the ones that are.
function withHidden(order, previous) {
  const shown = new Set(order);
  return [...order, ...(previous || []).filter((entry) => !shown.has(entry))];
}

// The layout after dragging the tag group dragKey before or after targetKey. shownKeys is the tag
// groups' order on screen.
export function moveTagGroup(layout, shownKeys, dragKey, targetKey, after) {
  const current = normalizeTopicLayout(layout);
  if (!dragKey || dragKey === targetKey) return null;
  const order = moveInList(shownKeys, dragKey, targetKey, after);
  return { ...current, tag_order: withHidden(order, current.tag_order) };
}

// The layout after dropping topic id into groupKey before or after targetID (or at the end).
// shownIDs is the group's topic order on screen, without the topic when it comes from elsewhere.
export function moveGroupTopic(layout, groupKey, shownIDs, id, targetID, after) {
  const current = normalizeTopicLayout(layout);
  if (!groupKey || !id || id === targetID) return null;
  const order = moveInList(shownIDs, id, targetID, after);
  return { ...current, topic_order: { ...current.topic_order, [groupKey]: withHidden(order, current.topic_order[groupKey]) } };
}
