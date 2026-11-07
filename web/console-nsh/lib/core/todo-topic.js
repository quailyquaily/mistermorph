import { CRON_TOPIC_PREFIX } from "./chat-cron-topics.js";

// A TODO item's runs land in its topic, "_cron_<task_id>" (daemonruntime.CronTopicID), which the
// runtime creates when the item's first run starts. The TODO view links to that topic only once it
// is there, and looking it up never creates it.

// After a manual run is accepted, the dialog looks for the topic once a second for half a minute.
export const TODO_TOPIC_POLL_INTERVAL_MS = 1000;
export const TODO_TOPIC_POLL_TIMEOUT_MS = 30000;

export const TODO_TOPIC_READY = "ready";
export const TODO_TOPIC_UNAVAILABLE = "unavailable";
export const TODO_TOPIC_ERROR = "error";
export const TODO_TOPIC_CANCELLED = "cancelled";

function text(value) {
  return String(value || "").trim();
}

// todoTopicID is the topic of the TODO item with this ID, or "" without an ID.
export function todoTopicID(taskID) {
  const id = text(taskID);
  return id ? CRON_TOPIC_PREFIX + id : "";
}

// todoTopicsEndpointRef is the endpoint whose topics the Topics page lists while endpointRef is
// selected, as ChatView decides it: the endpoint it submits to, when that runs a Console. Without
// one the page lists no topics, so there is nothing to link to and "" is returned.
export function todoTopicsEndpointRef(endpointRef, endpointByRef) {
  const selected = typeof endpointByRef === "function" ? endpointByRef(text(endpointRef)) : null;
  if (!selected) {
    return "";
  }
  const mapped = text(selected.submit_endpoint_ref);
  const submitRef = mapped || (selected.can_submit ? text(selected.endpoint_ref) : "");
  if (!submitRef) {
    return "";
  }
  const submit = endpointByRef(submitRef);
  const mode = text(submit?.mode || selected.mode).toLowerCase();
  return mode === "console" ? submitRef : "";
}

// todoTopicChatPath is the Topics page path that opens the topic, under the endpoint's routes.
export function todoTopicChatPath(topicID) {
  const id = text(topicID);
  return id ? `/chat/${encodeURIComponent(id)}` : "";
}

// findTodoTopic asks the endpoint for the item's topic with one GET /topics/<id>: the topic's ID
// when it is there, "" when it is not (404). Any other failure is thrown.
export async function findTodoTopic(fetchForEndpoint, endpointRef, taskID) {
  const topicID = todoTopicID(taskID);
  const ref = text(endpointRef);
  if (!topicID || !ref) {
    return "";
  }
  try {
    const topic = await fetchForEndpoint(ref, `/topics/${encodeURIComponent(topicID)}`);
    return text(topic?.id) === topicID ? topicID : "";
  } catch (e) {
    if (e?.status === 404) {
      return "";
    }
    throw e;
  }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

// waitForTodoTopic calls lookup (which resolves the topic's ID, or "" while there is none) until
// the topic is there, timeoutMs has passed, lookup fails, or signal aborts. It only ever reads; the
// run it waits for was requested before. The result is { status, topicID, error }, status being
// ready, unavailable (timed out), error or cancelled.
export async function waitForTodoTopic(
  lookup,
  {
    signal = null,
    intervalMs = TODO_TOPIC_POLL_INTERVAL_MS,
    timeoutMs = TODO_TOPIC_POLL_TIMEOUT_MS,
    sleep = abortableSleep,
    now = () => Date.now(),
  } = {}
) {
  const deadline = now() + Math.max(0, timeoutMs);
  for (;;) {
    if (signal?.aborted) {
      return { status: TODO_TOPIC_CANCELLED, topicID: "", error: null };
    }
    let topicID = "";
    try {
      topicID = text(await lookup());
    } catch (error) {
      if (signal?.aborted) {
        return { status: TODO_TOPIC_CANCELLED, topicID: "", error: null };
      }
      return { status: TODO_TOPIC_ERROR, topicID: "", error };
    }
    if (signal?.aborted) {
      return { status: TODO_TOPIC_CANCELLED, topicID: "", error: null };
    }
    if (topicID) {
      return { status: TODO_TOPIC_READY, topicID, error: null };
    }
    const left = deadline - now();
    if (left <= 0) {
      return { status: TODO_TOPIC_UNAVAILABLE, topicID: "", error: null };
    }
    await sleep(Math.min(intervalMs, left), signal);
  }
}
