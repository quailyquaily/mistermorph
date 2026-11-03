// Recently picked workspace directories, remembered per browser. The Chat workspace and the
// TODO workspace pickers share one list.

const RECENT_WORKSPACE_DIRS_STORAGE_KEY = "mistermorph_console_recent_workspaces_v1";
const RECENT_WORKSPACE_DIRS_LIMIT = 32;

export function normalizeRecentWorkspaceDirs(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const items = [];
  for (const item of raw) {
    const path = String(item || "").trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    items.push(path);
    if (items.length >= RECENT_WORKSPACE_DIRS_LIMIT) {
      break;
    }
  }
  return items;
}

export function loadRecentWorkspaceDirs() {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACE_DIRS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return normalizeRecentWorkspaceDirs(JSON.parse(raw));
  } catch {
    return [];
  }
}

// rememberRecentWorkspaceDir moves dir to the front of the stored list and returns the new list.
export function rememberRecentWorkspaceDir(dir) {
  const current = loadRecentWorkspaceDirs();
  const path = String(dir || "").trim();
  const next = path ? normalizeRecentWorkspaceDirs([path, ...current]) : current;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(RECENT_WORKSPACE_DIRS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The directory just is not remembered.
    }
  }
  return next;
}
