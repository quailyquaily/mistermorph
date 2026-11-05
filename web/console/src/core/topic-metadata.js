import { onMounted, onUnmounted, watch } from "vue";
import "../styles/topic-icons.css";
import { runtimeApiFetchForEndpoint } from "./context";
import { loadResource, resourceKey } from "./resources";
import { mergeTopicMetadata } from "./topic-metadata-merge.js";

const topicIcons = import.meta.glob("../assets/topic-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

export function topicIcon(topic) {
  return topicIcons[`../assets/topic-icons/${topic?.icon}.svg`] || topicIcons["../assets/topic-icons/chat.svg"];
}

// Merge naming results without resetting pagination, selection, or drafts. followsActivity says
// which topics also take a newer updated_at (see mergeTopicMetadata).
export function useTopicMetadata(topics, endpointRef, followsActivity = () => false) {
  let timer;
  let version = 0;
  let loading = false;
  let disposed = false;
  watch(endpointRef, () => { version += 1; });

  async function refresh() {
    const endpoint = endpointRef.value;
    if (disposed || loading || document.hidden || !endpoint || !topics.value.length) return;
    const requestVersion = version;
    const original = new Map(topics.value.map((topic) => [topic.id, topic]));
    loading = true;
    try {
      const data = await loadResource(resourceKey("topic-metadata", endpoint), () =>
        runtimeApiFetchForEndpoint(endpoint, "/topics?limit=100")
      );
      if (disposed || version !== requestVersion || endpoint !== endpointRef.value) return;
      const updated = new Map((data?.items || []).map((topic) => [topic.id, topic]));
      topics.value = topics.value.map((topic) => {
        if (topic !== original.get(topic.id)) return topic;
        return mergeTopicMetadata(topic, updated.get(topic.id), followsActivity(topic));
      });
    } catch {
      // Keep the current metadata; the next poll will retry.
    } finally {
      loading = false;
    }
  }

  onMounted(() => { timer = window.setInterval(refresh, 5000); });
  onUnmounted(() => { disposed = true; window.clearInterval(timer); });
}
