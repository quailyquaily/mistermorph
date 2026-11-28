// Which model a form shows when its provider changes: the model last set for that provider on
// this agent (the agent's own record, `llm_last_models` of its settings), else the default this
// console knows for the provider, checked against the provider's own list where it has one.

/**
 * The default model of the popular providers, for a provider nobody has set a model for yet.
 * Codex has none here: its default is the first model its own list names (the Codex CLI's).
 * A provider that is not here gets no model: the user chooses one.
 */
export const DEFAULT_PROVIDER_MODELS = {
  openai: "gpt-6.2-sol",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-4-carbon",
  xai: "grok-4.7",
  xai_oauth: "grok-4.5",
  deepseek: "deepseek-v4-flash",
  kimi: "kimi-k3",
  groq: "openai/gpt-oss-120b",
  meta: "muse-spark-1.1",
  sakana: "fugu-ultra-20260615",
};

const text = (value) => String(value ?? "").trim();
const key = (provider) => text(provider).toLowerCase();

/** The model last set for `provider`, from the agent's record; "" when none. */
export function lastProviderModel(lastModels, provider) {
  const record = lastModels && typeof lastModels === "object" ? lastModels : {};
  return text(record[key(provider)]);
}

/**
 * What the model field takes the moment the provider changes, before any list is read: the last
 * model set for it, else the provider's default, else nothing (the model of the provider that
 * was there before never stays). `remembered` says the model is the last one set, so a list read
 * afterwards checks it instead of replacing it.
 */
export function initialProviderModel(provider, lastModels) {
  const last = lastProviderModel(lastModels, provider);
  if (last) return { model: last, remembered: true };
  return { model: text(DEFAULT_PROVIDER_MODELS[key(provider)]), remembered: false };
}

/** The model to offer from a provider's list: its default when the list has it; for Codex, the list's first. */
export function suggestedProviderModel(provider, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(text).filter(Boolean);
  const preferred = text(DEFAULT_PROVIDER_MODELS[key(provider)]);
  if (preferred && list.includes(preferred)) return preferred;
  return key(provider) === "openai_codex" ? list[0] || "" : "";
}

/**
 * What a provider's list says about the model the field took (initialProviderModel):
 * - `{}`: nothing to do (no list, or the model is in it);
 * - `{ model }`: no model was remembered, so the field takes the list's own suggestion ("" when the
 *   list has none this console knows: the user chooses);
 * - `{ missing: { model, suggestion } }`: the remembered model is not in the list any more.
 */
export function checkProviderModel({ provider, model, remembered, ids }) {
  const list = (Array.isArray(ids) ? ids : []).map(text).filter(Boolean);
  if (list.length === 0) return {};
  const current = text(model);
  if (remembered) {
    if (!current || list.includes(current)) return {};
    return { missing: { model: current, suggestion: suggestedProviderModel(provider, list) } };
  }
  const suggestion = suggestedProviderModel(provider, list);
  return suggestion === current ? {} : { model: suggestion };
}

/** The model ids of a `/settings/agent/models` answer, in its order. */
export function modelIDsFromPayload(payload) {
  // `items` is the plain list; an answer with only `models` (each with its id) reads the same.
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const models = Array.isArray(payload?.models) ? payload.models.map((model) => model?.id) : [];
  return (items.length > 0 ? items : models).map(text).filter(Boolean);
}
