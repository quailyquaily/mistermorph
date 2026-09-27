// An llm.routes.<purpose> value as the settings editor sees it. The config accepts a profile name
// ("cheap") or an object with either `profile` or weighted `candidates`, plus `fallback_profiles`.
// Unset means the default profile.

export const ROUTE_MODE_DEFAULT = "default";
export const ROUTE_MODE_PROFILE = "profile";
export const ROUTE_MODE_SPLIT = "split";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function names(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const name = text(item);
    if (name && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

// Accepts the parsed config value (string, object or null).
export function routeFromValue(value) {
  if (typeof value === "string") {
    const profile = value.trim();
    return { mode: profile ? ROUTE_MODE_PROFILE : ROUTE_MODE_DEFAULT, profile, candidates: [], fallbacks: [] };
  }
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ profile: text(item.profile), weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 1 }));
  const profile = text(raw.profile);
  const mode = candidates.length ? ROUTE_MODE_SPLIT : profile ? ROUTE_MODE_PROFILE : ROUTE_MODE_DEFAULT;
  return { mode, profile, candidates, fallbacks: names(raw.fallback_profiles) };
}

// The config value to save. An unset route is {} so it matches what the server reports for one.
export function routeToValue(route) {
  const out = {};
  if (route.mode === ROUTE_MODE_PROFILE && text(route.profile)) {
    out.profile = text(route.profile);
  }
  if (route.mode === ROUTE_MODE_SPLIT) {
    out.candidates = route.candidates.map((item) => ({ profile: text(item.profile), weight: Number(item.weight) }));
  }
  const fallbacks = names(route.fallbacks);
  if (fallbacks.length) {
    out.fallback_profiles = fallbacks;
  }
  return out;
}

// Problems the server would reject or that would fail at run time. `known` is the list of profile
// names that exist (including "default"); pass null to skip that check.
export function routeProblems(route, known = null) {
  const problems = [];
  const missing = (name) => Array.isArray(known) && name && !known.includes(name);
  if (route.mode === ROUTE_MODE_PROFILE) {
    if (!text(route.profile)) {
      problems.push("Choose a profile.");
    } else if (missing(text(route.profile))) {
      problems.push(`No profile is named "${text(route.profile)}".`);
    }
  }
  if (route.mode === ROUTE_MODE_SPLIT) {
    if (!route.candidates.length) {
      problems.push("Add at least one profile to split between.");
    }
    route.candidates.forEach((item, index) => {
      const name = text(item.profile);
      if (!name) {
        problems.push(`Share ${index + 1}: choose a profile.`);
      } else if (missing(name)) {
        problems.push(`No profile is named "${name}".`);
      }
      if (!Number.isInteger(Number(item.weight)) || Number(item.weight) <= 0) {
        problems.push(`Share ${index + 1}: weight must be a whole number above 0.`);
      }
    });
  }
  for (const name of names(route.fallbacks)) {
    if (missing(name)) {
      problems.push(`No profile is named "${name}".`);
    }
  }
  return [...new Set(problems)];
}

// Each candidate's share of traffic, as a whole percentage.
export function routeShares(candidates) {
  const weights = candidates.map((item) => Math.max(0, Number(item.weight) || 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => (total > 0 ? Math.round((weight / total) * 100) : 0));
}

// The routes the Routes page shows, in order. `legacy` routes are shown only while set.
export const ROUTE_PURPOSES = [
  { key: "main_loop", path: "llm.routes.main_loop", label: "Main loop", note: "Every step of a task." },
  { key: "decision", path: "llm.routes.decision", label: "Decision", note: "Whether to reply in group chats." },
  {
    key: "addressing",
    path: "llm.routes.addressing",
    label: "Addressing",
    note: "Older name for Decision; used only while Decision is on the default profile.",
    legacy: true,
    replacedBy: "decision",
  },
  { key: "awareness", path: "llm.routes.awareness", label: "Awareness", note: "Background awareness checks." },
  { key: "think", path: "llm.routes.think", label: "Think", note: "/think tasks, run with reasoning effort xhigh." },
  { key: "plan_create", path: "llm.routes.plan_create", label: "Plan creation", note: "Writing plans with plan_create." },
];

export function routeIsUnset(route) {
  return route.mode === ROUTE_MODE_DEFAULT && !names(route.fallbacks).length;
}

// Where a route's requests go: [{ profile, share }]. An unset profile means "default".
export function routeTargets(route) {
  if (route.mode === ROUTE_MODE_SPLIT) {
    const shares = routeShares(route.candidates);
    return route.candidates.map((item, index) => ({ profile: text(item.profile), share: shares[index] }));
  }
  const profile = route.mode === ROUTE_MODE_PROFILE ? text(route.profile) || "default" : "default";
  return [{ profile, share: 100 }];
}

// Weights rescaled to whole percentages that add up to 100, so dragging a split moves in 1% steps.
export function percentWeights(candidates) {
  const weights = candidates.map((item) => Math.max(0, Number(item.weight) || 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    const even = Math.floor(100 / Math.max(1, candidates.length));
    return candidates.map((_, index) => (index === 0 ? 100 - even * (candidates.length - 1) : even));
  }
  const exact = weights.map((weight) => (weight / total) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0]);
  for (const [, index] of order) {
    if (left <= 0) break;
    out[index] += 1;
    left -= 1;
  }
  return out;
}
