import { sameTopicTags } from "./topic-tags.js";

// What a metadata poll changes in a loaded topic: its name, icon and tags. It returns the topic
// itself when nothing changed, or when the poll's copy is the older one.
//
// followsActivity also takes a newer updated_at on its own. That is for topics whose list is
// ordered by it and that get new tasks while nobody chats in them, such as the TODO items'. The
// other lists keep the order they were loaded in, so their topics do not take it.
export function mergeTopicMetadata(topic, next, followsActivity = false) {
  if (
    !next ||
    Number(next.title_revision || 0) < Number(topic.title_revision || 0) ||
    Date.parse(next.updated_at) < Date.parse(topic.updated_at)
  ) {
    return topic;
  }
  const sameNaming =
    next.title === topic.title &&
    next.icon === topic.icon &&
    next.llm_title_generated_at === topic.llm_title_generated_at &&
    next.title_revision === topic.title_revision &&
    sameTopicTags(next.tags || [], topic.tags || []);
  if (sameNaming && !(followsActivity && next.updated_at !== topic.updated_at)) {
    return topic;
  }
  return { ...topic, ...next };
}
