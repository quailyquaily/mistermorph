const draftsByScope = new Map();
const NEW_TOPIC_SCOPE_ID = "__new__";

function normalizeEndpointRef(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTopicID(value) {
  return String(value || "").trim();
}

function normalizeDraftText(value) {
  return typeof value === "string" ? value : String(value || "");
}

function scopeKey(endpointRef, topicID) {
  const normalizedEndpointRef = normalizeEndpointRef(endpointRef);
  if (!normalizedEndpointRef) {
    return "";
  }
  const normalizedTopicID = normalizeTopicID(topicID) || NEW_TOPIC_SCOPE_ID;
  return `${normalizedEndpointRef}\n${normalizedTopicID}`;
}

function rememberChatDraft(endpointRef, topicID, text) {
  const key = scopeKey(endpointRef, topicID);
  if (!key) {
    return;
  }
  const normalizedText = normalizeDraftText(text);
  if (!normalizedText) {
    draftsByScope.delete(key);
    return;
  }
  draftsByScope.set(key, normalizedText);
}

function chatDraft(endpointRef, topicID) {
  const key = scopeKey(endpointRef, topicID);
  if (!key) {
    return "";
  }
  return normalizeDraftText(draftsByScope.get(key));
}

function clearChatDraft(endpointRef, topicID) {
  const key = scopeKey(endpointRef, topicID);
  if (!key) {
    return;
  }
  draftsByScope.delete(key);
}

export { chatDraft, clearChatDraft, rememberChatDraft };
