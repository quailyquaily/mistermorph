// Helpers for installing skills from the Skills page. The install itself runs as an ordinary chat
// task: the agent previews the skill, explains it, and asks for approval on skill_install.

function normalizeInstallLink(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname ? url.href : "";
  } catch {
    return "";
  }
}

// The chat message that starts an install. `t` renders it in the console's language. A store
// skill is named by its store id; `update` asks to replace the installed copy.
function skillInstallTask(t, target = {}) {
  const storeID = String(target.storeID || "").trim();
  if (storeID) {
    const name = String(target.name || storeID).trim();
    return t(target.update ? "skills_install_task_store_update" : "skills_install_task_store", { name, id: storeID });
  }
  const link = normalizeInstallLink(target.link);
  return link ? t("skills_install_task_link", { link }) : "";
}

// Where an installed skill came from, read from its provenance.
function skillSourceInfo(source) {
  const kind = String(source?.kind || "").trim();
  if (!kind) {
    return { kind: "local", url: "", repo: "", commit: "", version: "", storeID: "", installedAt: "" };
  }
  return {
    kind,
    url: String(source.url || ""),
    repo: String(source.repo || ""),
    commit: String(source.commit || ""),
    version: String(source.version || ""),
    storeID: String(source.store_id || ""),
    installedAt: String(source.installed_at || ""),
  };
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

// One entry of GET /settings/agent/skills/store.
function normalizeStoreSkill(item, repo = "") {
  const files = item?.files && typeof item.files === "object" ? Object.keys(item.files) : [];
  return {
    id: String(item?.id || "").trim(),
    name: String(item?.name || item?.id || "").trim(),
    version: String(item?.version || "").trim(),
    description: String(item?.description || "").trim(),
    author: String(item?.author || "").trim(),
    license: String(item?.license || "").trim(),
    homepage: String(item?.homepage || "").trim(),
    tags: stringList(item?.tags),
    requirements: stringList(item?.requirements),
    authProfiles: stringList(item?.auth_profiles),
    path: String(item?.path || "").replace(/^\/+|\/+$/g, ""),
    commit: String(item?.commit || "").trim(),
    repo: String(repo || "").trim(),
    fileCount: files.length,
    totalBytes: Number(item?.total_bytes) || 0,
    installed: item?.installed === true,
    installedVersion: String(item?.installed_version || "").trim(),
    updateAvailable: item?.update_available === true,
  };
}

// The skill's folder on GitHub and its SKILL.md, both at the commit the store pins.
function storeSkillLinks(skill) {
  if (!skill?.repo || !/^[0-9a-f]{40}$/i.test(skill.commit || "")) {
    return { folder: "", document: "" };
  }
  const path = skill.path ? `/${skill.path}` : "";
  return {
    folder: `https://github.com/${skill.repo}/tree/${skill.commit}${path}`,
    document: `https://raw.githubusercontent.com/${skill.repo}/${skill.commit}${path}/SKILL.md`,
  };
}

// The store's tags, most used first, for the filter row.
function storeTags(items) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags || []) {
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

// SKILL.md without its frontmatter, which pages show as facts above the document.
function stripFrontmatter(content) {
  const text = String(content || "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length).trimStart() : text;
}

// Case-insensitive match on name, id, description and (for store skills) tags.
function filterSkills(items, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items.filter((item) =>
    [item.name, item.id, item.description, ...(item.tags || [])].some((field) => String(field || "").toLowerCase().includes(needle)),
  );
}

export { filterSkills, normalizeInstallLink, normalizeStoreSkill, skillInstallTask, skillSourceInfo, storeSkillLinks, storeTags, stripFrontmatter };
