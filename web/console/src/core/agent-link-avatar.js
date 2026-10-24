// Agent Link contacts are other agents this Console connects to, with contact IDs of the form
// "mm:<instance_id>". The Console already holds each of its agents' avatars (the endpoint list's
// avatar_url, a data URL), so such a contact shows its agent's avatar when the agent is one of
// this Console's endpoints.

const AGENT_LINK_PREFIX = "mm:";
const INSTANCE_ID = /^inst_[0-9a-f]{32}$/;

function agentLinkInstanceID(contactID) {
  const id = String(contactID || "").trim();
  if (id.slice(0, AGENT_LINK_PREFIX.length).toLowerCase() !== AGENT_LINK_PREFIX) {
    return "";
  }
  const instanceID = id.slice(AGENT_LINK_PREFIX.length).trim();
  return INSTANCE_ID.test(instanceID) ? instanceID : "";
}

// agentLinkAvatarURL returns the avatar of the agent behind an Agent Link contact, or "" when the
// contact is not one or its agent is not an endpoint with an avatar.
function agentLinkAvatarURL(contact, endpoints) {
  const instanceID = agentLinkInstanceID(contact?.contact_id);
  if (!instanceID || !Array.isArray(endpoints)) {
    return "";
  }
  const endpoint = endpoints.find((item) => String(item?.instance_id || "").trim() === instanceID);
  return String(endpoint?.avatar_url || "").trim();
}

export { agentLinkAvatarURL, agentLinkInstanceID };
