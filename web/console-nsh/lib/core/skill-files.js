import { signal } from "nsh";

// The Skills page's read-only file browser: one folder is listed at a time through
// /settings/agent/skills/dir, and one file is previewed through /settings/agent/skills/file.
// Paths are relative to the skill folder, with forward slashes; "" is the folder itself.

export const SKILL_DOC_PATH = "SKILL.md";

const ENTRY_KINDS = new Set(["dir", "file", "symlink", "other"]);
const PREVIEW_KINDS = new Set(["text", "binary", "too_large", "unsupported"]);

export function skillDirURL(id, path = "") {
  const q = new URLSearchParams();
  q.set("id", String(id || ""));
  if (path) {
    q.set("path", String(path));
  }
  return `/settings/agent/skills/dir?${q.toString()}`;
}

export function skillFileURL(id, path) {
  const q = new URLSearchParams();
  q.set("id", String(id || ""));
  q.set("path", String(path || ""));
  return `/settings/agent/skills/file?${q.toString()}`;
}

function normalizeEntry(item, parent) {
  const name = String(item?.name || "");
  if (!name) {
    return null;
  }
  const path = String(item?.path || (parent ? `${parent}/${name}` : name));
  const kind = ENTRY_KINDS.has(item?.kind) ? item.kind : "other";
  return { name, path, kind, size: Number(item?.size) || 0 };
}

export function normalizeSkillDirListing(data, requestedPath = "") {
  const path = typeof data?.path === "string" ? data.path : requestedPath;
  const entries = (Array.isArray(data?.entries) ? data.entries : []).map((item) => normalizeEntry(item, path)).filter(Boolean);
  return { path, entries, capped: data?.capped === true };
}

export function normalizeSkillFilePreview(data, requestedPath = "") {
  const path = String(data?.path || requestedPath);
  return {
    path,
    name: String(data?.name || path.split("/").pop() || ""),
    size: Number(data?.size) || 0,
    kind: PREVIEW_KINDS.has(data?.kind) ? data.kind : "unsupported",
    // Only text has content; it is shown as text, never as HTML or rendered markdown.
    content: data?.kind === "text" && typeof data?.content === "string" ? data.content : "",
    limit: Number(data?.limit) || 256 * 1024,
  };
}

// What went wrong reading a folder or file. An agent without these routes answers 404 without
// a code; the page then falls back to the catalog's flat file list.
export function skillPathErrorKind(err) {
  const code = String(err?.code || "");
  switch (code) {
    case "path_not_found":
    case "skill_not_found":
      return "missing";
    case "access_denied":
      return "denied";
    case "symlink":
      return "symlink";
    case "invalid_path":
    case "not_directory":
    case "not_file":
      return "invalid";
    default:
      return err?.status === 404 ? "unsupported" : "failed";
  }
}

export function isSelectableSkillEntry(entry) {
  return entry?.kind === "file";
}

// The rows the tree shows, depth first from the skill folder. nodes maps a folder path to
// { status: "loading" | "ready" | "error", entries, capped, error }; expanded holds the open
// folder paths. A folder that is open but not read yet shows as loading.
export function skillTreeRows(nodes, expanded, path = "", depth = 0) {
  const node = nodes?.[path];
  if (!node || node.status === "loading") {
    return [{ type: "loading", key: `${path}#loading`, path, depth }];
  }
  if (node.status === "error") {
    return [{ type: "error", key: `${path}#error`, path, depth, error: node.error || "failed" }];
  }
  if (!node.entries?.length) {
    return [{ type: "empty", key: `${path}#empty`, path, depth }];
  }
  const rows = [];
  for (const entry of node.entries) {
    const open = entry.kind === "dir" && expanded?.has(entry.path);
    rows.push({ type: "entry", key: entry.path, path: entry.path, depth, entry, open });
    if (open) {
      rows.push(...skillTreeRows(nodes, expanded, entry.path, depth + 1));
    }
  }
  if (node.capped) {
    rows.push({ type: "capped", key: `${path}#capped`, path, depth, count: node.entries.length });
  }
  return rows;
}

// A counter that makes answers to old requests easy to drop. next() hands out a ticket that
// makes every earlier one stale (another skill, agent or file); peek() shares the current one,
// for requests that may run side by side (folders of the same tree).
export function createRequestGuard() {
  let generation = 0;
  return {
    next: () => {
      generation += 1;
      return generation;
    },
    peek: () => generation,
    current: (ticket) => ticket === generation,
  };
}

// The file shown in place of SKILL.md. path is "" while SKILL.md is shown; state is null then,
// or { status: "loading" | "ready" | "error", path, data, error, message }. fetchFile(id, path)
// is called at once, so it can read the current agent before the first await. Opening another
// file, or clear() (another skill or agent), drops answers still on their way.
export function useSkillFilePreview(fetchFile) {
  const path = signal("");
  const state = signal(null);
  const guard = createRequestGuard();

  function clear() {
    guard.next();
    path.set("");
    state.set(null);
  }

  async function open(id, filePath) {
    if (!id || !filePath || filePath === SKILL_DOC_PATH) {
      clear();
      return;
    }
    const ticket = guard.next();
    path.set(filePath);
    state.set({ status: "loading", path: filePath });
    try {
      const data = await fetchFile(id, filePath);
      if (guard.current(ticket)) {
        state.set({ status: "ready", path: filePath, data: normalizeSkillFilePreview(data, filePath) });
      }
    } catch (e) {
      if (guard.current(ticket)) {
        state.set({ status: "error", path: filePath, error: skillPathErrorKind(e), message: String(e?.message || "") });
      }
    }
  }

  return { path, state, open, clear };
}
