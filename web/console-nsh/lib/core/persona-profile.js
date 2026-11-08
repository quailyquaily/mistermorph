import { isMap, parseDocument } from "../vendor/yaml.js";

const PERSONA_IDENTITY_FILE = "identity.yaml";
const PERSONA_SOUL_FILE = "soul.md";
const PERSONA_IDENTITY_ENDPOINT = `/persona/files/${PERSONA_IDENTITY_FILE}`;
const PERSONA_SOUL_ENDPOINT = `/persona/files/${PERSONA_SOUL_FILE}`;
// The identity and its soul as fields (rows of agent.db). The two file endpoints above stay for
// runtimes from before agent.db, which answer 404 here.
const PERSONA_IDENTITY_API = "/persona/identity";
const PERSONA_AVATAR_ENDPOINT = "/persona/avatar";
const PERSONA_IDENTITY_UPDATED_EVENT = "mistermorph:persona-identity-updated";
const PERSONA_AVATAR_UPDATED_EVENT = "mistermorph:persona-avatar-updated";
const PERSONA_AVATAR_SIZE = 512;
const PERSONA_AVATAR_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const PERSONA_AVATAR_SOURCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IDENTITY_FIELDS = ["name", "creature", "vibe", "emoji"];
const IDENTITY_YAML_FENCE_RE = /```ya?ml\s*\n([\s\S]*?)```/i;

function trimText(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function buildEmptyPersonaIdentityState() {
  return {
    name: "",
    creature: "",
    vibe: "",
    emoji: "",
  };
}

function extractIdentityYAML(raw) {
  const content = normalizeText(raw);
  const match = IDENTITY_YAML_FENCE_RE.exec(content);
  return match ? match[1] : content;
}

function createIdentityDocument(raw) {
  const source = extractIdentityYAML(raw).trim();
  const doc = parseDocument(source || "{}", { prettyErrors: false });
  if (doc.errors.length > 0) {
    throw new Error(`identity.yaml is invalid: ${doc.errors[0].message}`);
  }
  if (!isMap(doc.contents)) {
    return null;
  }
  return doc;
}

function parseIdentityProfile(raw) {
  const profile = buildEmptyPersonaIdentityState();
  let doc;
  try {
    doc = createIdentityDocument(raw);
  } catch {
    return profile;
  }
  if (!doc) {
    return profile;
  }
  const parsed = doc.toJS();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return profile;
  }
  for (const field of IDENTITY_FIELDS) {
    profile[field] = trimText(parsed[field]);
  }
  return profile;
}

function buildPersonaIdentitySnapshot(values) {
  return JSON.stringify({
    name: trimText(values?.name),
    creature: trimText(values?.creature),
    vibe: trimText(values?.vibe),
    emoji: trimText(values?.emoji),
  });
}

function setIdentityField(map, field, value) {
  map.set(field, trimText(value));
}

function identityYAMLToString(doc) {
  const output = doc.toString({ lineWidth: 0 }).trim();
  return output ? `${output}\n` : "";
}

function buildDefaultIdentityYAML(values) {
  const doc = parseDocument("{}");
  doc.contents = doc.createNode({
    name: trimText(values?.name),
    name_alts: [],
    creature: trimText(values?.creature),
    vibe: trimText(values?.vibe),
    emoji: trimText(values?.emoji),
  });
  return identityYAMLToString(doc);
}

function buildIdentityYAML(values, previousRaw = "") {
  if (!trimText(previousRaw)) {
    return buildDefaultIdentityYAML(values);
  }
  const doc = createIdentityDocument(previousRaw);
  if (!doc) {
    return buildDefaultIdentityYAML(values);
  }
  const map = doc.contents;
  for (const field of IDENTITY_FIELDS) {
    setIdentityField(map, field, values?.[field]);
  }
  return identityYAMLToString(doc);
}

function normalizeSoulDocument(raw) {
  const value = normalizeText(raw).trim();
  return value ? `${value}\n` : "";
}

// A persona record is what the Console edits: the four identity fields, the soul, and which API the
// runtime has. "identity" is /persona/identity; "files" is identity.yaml and soul.md on a runtime
// from before agent.db, where identityRaw keeps the YAML so a save leaves its other keys alone.
function personaRecordFromIdentityPayload(payload) {
  const identity = payload?.identity && typeof payload.identity === "object" ? payload.identity : {};
  const profile = buildEmptyPersonaIdentityState();
  for (const field of IDENTITY_FIELDS) {
    profile[field] = trimText(identity[field]);
  }
  const soul = normalizeSoulDocument(identity.soul);
  return {
    api: "identity",
    exists: payload?.exists === true,
    profile,
    identityRaw: "",
    soul,
    soulExists: soul !== "",
  };
}

async function readPersonaFile(fetchJSON, endpoint, options) {
  try {
    const payload = await fetchJSON(endpoint, options);
    return { exists: true, content: normalizeText(payload?.content || "") };
  } catch (err) {
    if (err?.status === 404) {
      return { exists: false, content: "" };
    }
    throw err;
  }
}

// loadPersonaRecord reads the persona with fetchJSON(path, options), the endpoint's runtime fetch.
async function loadPersonaRecord(fetchJSON, options = {}) {
  try {
    return personaRecordFromIdentityPayload(await fetchJSON(PERSONA_IDENTITY_API, options));
  } catch (err) {
    if (err?.status !== 404) {
      throw err;
    }
  }
  const identity = await readPersonaFile(fetchJSON, PERSONA_IDENTITY_ENDPOINT, options);
  const soul = await readPersonaFile(fetchJSON, PERSONA_SOUL_ENDPOINT, options);
  return {
    api: "files",
    exists: identity.exists,
    profile: parseIdentityProfile(identity.content),
    identityRaw: identity.content,
    soul: normalizeSoulDocument(soul.content),
    soulExists: soul.exists,
  };
}

// savePersonaRecord writes change.profile (the four fields) and/or change.soul over record, in the
// API record came from, and returns the record as saved.
async function savePersonaRecord(fetchJSON, record, change = {}) {
  const profile = change.profile ? buildEmptyPersonaIdentityState() : null;
  if (profile) {
    for (const field of IDENTITY_FIELDS) {
      profile[field] = trimText(change.profile[field]);
    }
  }
  const soul = typeof change.soul === "string" ? normalizeSoulDocument(change.soul) : null;
  if (record?.api !== "files") {
    const body = { ...(profile || {}) };
    if (soul !== null) {
      body.soul = soul;
    }
    return personaRecordFromIdentityPayload(await fetchJSON(PERSONA_IDENTITY_API, { method: "PUT", body }));
  }
  const next = { ...record };
  if (profile) {
    const content = buildIdentityYAML(profile, record.identityRaw);
    await fetchJSON(PERSONA_IDENTITY_ENDPOINT, { method: "PUT", body: { content } });
    Object.assign(next, { exists: true, profile, identityRaw: content });
  }
  if (soul !== null) {
    await fetchJSON(PERSONA_SOUL_ENDPOINT, { method: "PUT", body: { content: soul } });
    Object.assign(next, { soul, soulExists: true });
  }
  return next;
}

// What window events were to the Vue console: pages that show the persona listen with
// onPersonaEvent(PERSONA_AVATAR_UPDATED_EVENT, listener), which returns a function that stops it.
const personaListeners = new Map();

function onPersonaEvent(name, listener) {
  if (!personaListeners.has(name)) {
    personaListeners.set(name, new Set());
  }
  personaListeners.get(name).add(listener);
  return () => personaListeners.get(name)?.delete(listener);
}

function emitPersonaEvent(name) {
  for (const listener of personaListeners.get(name) || []) {
    listener({ detail: { at: Date.now() } });
  }
}

function dispatchPersonaAvatarUpdated() {
  emitPersonaEvent(PERSONA_AVATAR_UPDATED_EVENT);
}

function dispatchPersonaIdentityUpdated() {
  emitPersonaEvent(PERSONA_IDENTITY_UPDATED_EVENT);
}

export {
  loadPersonaRecord,
  onPersonaEvent,
  personaRecordFromIdentityPayload,
  savePersonaRecord,
  buildEmptyPersonaIdentityState,
  buildIdentityYAML,
  buildPersonaIdentitySnapshot,
  dispatchPersonaIdentityUpdated,
  dispatchPersonaAvatarUpdated,
  normalizeSoulDocument,
  parseIdentityProfile,
  PERSONA_AVATAR_ENDPOINT,
  PERSONA_AVATAR_MAX_SOURCE_BYTES,
  PERSONA_AVATAR_SIZE,
  PERSONA_AVATAR_SOURCE_TYPES,
  PERSONA_AVATAR_UPDATED_EVENT,
  PERSONA_IDENTITY_API,
  PERSONA_IDENTITY_ENDPOINT,
  PERSONA_IDENTITY_FILE,
  PERSONA_IDENTITY_UPDATED_EVENT,
  PERSONA_SOUL_ENDPOINT,
  PERSONA_SOUL_FILE,
};
