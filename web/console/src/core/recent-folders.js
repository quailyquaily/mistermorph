// The folders recently chosen in the folder browser, newest first, remembered per browser.

const RECENT_FOLDERS_STORAGE_KEY = "mistermorph_console_recent_workspaces_v1";
const RECENT_FOLDERS_LIMIT = 32;

function normalizeRecentFolders(raw) {
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
    if (items.length >= RECENT_FOLDERS_LIMIT) {
      break;
    }
  }
  return items;
}

export function loadRecentFolders() {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_STORAGE_KEY);
    return raw ? normalizeRecentFolders(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

// rememberRecentFolder puts dir first in the list and returns the new list.
export function rememberRecentFolder(dir) {
  const path = String(dir || "").trim();
  const items = normalizeRecentFolders(path ? [path, ...loadRecentFolders()] : loadRecentFolders());
  try {
    localStorage.setItem(RECENT_FOLDERS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // The list just is not remembered.
  }
  return items;
}
