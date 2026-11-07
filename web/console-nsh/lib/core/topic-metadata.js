import { cleanup, effect } from "nsh";
import topicIcons from "../generated/topic-icons.js";
import { isVisible } from "../platform";
import { runtimeApiFetchForEndpoint } from "./context";
import { loadResource, resourceKey } from "./resources";
import { mergeTopicMetadata } from "./topic-metadata-merge.js";


export function topicIcon(topic) {
  return topicIcons[topic?.icon] || topicIcons.chat;
}

// `topics` is a signal of the loaded topics and `endpointRef` an accessor of the endpoint.
// Merge naming results without resetting pagination, selection, or drafts. followsActivity says
// which topics also take a newer updated_at (see mergeTopicMetadata).
export function useTopicMetadata(topics, endpointRef, followsActivity = () => false) {
  let timer;
  let version = 0;
  let loading = false;
  let disposed = false;
  effect(() => {
    endpointRef();
    version += 1;
  });

  async function refresh() {
    const endpoint = endpointRef();
    if (disposed || loading || !isVisible() || !endpoint || !topics().length) return;
    const requestVersion = version;
    const original = new Map(topics().map((topic) => [topic.id, topic]));
    loading = true;
    try {
      const data = await loadResource(resourceKey("topic-metadata", endpoint), () =>
        runtimeApiFetchForEndpoint(endpoint, "/topics?limit=100")
      );
      if (disposed || version !== requestVersion || endpoint !== endpointRef()) return;
      const updated = new Map((data?.items || []).map((topic) => [topic.id, topic]));
      topics.set(topics().map((topic) => {
        if (topic !== original.get(topic.id)) return topic;
        return mergeTopicMetadata(topic, updated.get(topic.id), followsActivity(topic));
      }));
    } catch {
      // Keep the current metadata; the next poll will retry.
    } finally {
      loading = false;
    }
  }

  timer = setInterval(refresh, 5000);
  cleanup(() => {
    disposed = true;
    clearInterval(timer);
  });
}
