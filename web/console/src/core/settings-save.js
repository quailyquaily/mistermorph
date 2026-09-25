// Helpers for saving several settings scopes from one place.

// A scope is { id, dirty() -> bool, slice() -> object holding its draft, sync() -> recompute dirty }.
// Captures the drafts of dirty scopes that are not being saved, so a save response that rewrites
// every scope can be followed by restoreUnsavedScopes to put those edits back.
export function captureUnsavedScopes(scopes, savedScopes, secretKeys = []) {
  return scopes
    .filter((scope) => !savedScopes.includes(scope.id) && scope.dirty())
    .map((scope) => ({
      scope,
      values: JSON.parse(JSON.stringify(scope.slice())),
      secrets: [...secretKeys].filter((key) => key.startsWith(`${scope.id}.`)),
    }));
}

export function restoreUnsavedScopes(captured, secretKeys) {
  for (const { scope, values, secrets } of captured) {
    Object.assign(scope.slice(), values);
    for (const key of secrets) {
      secretKeys.add(key);
    }
    scope.sync();
  }
}

// Combines ConfigSettingsPanel updates ({ config_changes, reset }) that go to the same endpoint.
export function mergeConfigUpdates(updates) {
  const merged = { config_changes: {}, reset: [] };
  for (const update of updates) {
    if (!update) continue;
    Object.assign(merged.config_changes, update.config_changes || {});
    for (const path of update.reset || []) {
      if (!merged.reset.includes(path)) merged.reset.push(path);
    }
  }
  return merged;
}
