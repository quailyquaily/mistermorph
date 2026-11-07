const lastTopicIDsByEndpoint = new Map();

function normalizeEndpointRef(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTopicID(value) {
  return String(value || "").trim();
}

function rememberLastTopicID(endpointRef, topicID) {
  const normalizedEndpointRef = normalizeEndpointRef(endpointRef);
  const normalizedTopicID = normalizeTopicID(topicID);
  if (!normalizedEndpointRef || !normalizedTopicID) {
    return;
  }
  lastTopicIDsByEndpoint.set(normalizedEndpointRef, normalizedTopicID);
}

function lastTopicID(endpointRef) {
  const normalizedEndpointRef = normalizeEndpointRef(endpointRef);
  if (!normalizedEndpointRef) {
    return "";
  }
  return normalizeTopicID(lastTopicIDsByEndpoint.get(normalizedEndpointRef));
}

export { lastTopicID, rememberLastTopicID };
