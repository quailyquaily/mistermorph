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

// The chat message that starts an install. `t` renders it in the console's language.
function skillInstallTask(t, target = {}) {
  const storeID = String(target.storeID || "").trim();
  if (storeID) {
    return t("skills_install_task_store", { name: String(target.name || storeID).trim(), id: storeID });
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

function normalizeStoreSkill(item) {
  const list = (value) => (Array.isArray(value) ? value.map((v) => String(v || "").trim()).filter(Boolean) : []);
  return {
    id: String(item?.id || "").trim(),
    name: String(item?.name || item?.id || "").trim(),
    version: String(item?.version || "").trim(),
    description: String(item?.description || "").trim(),
    author: String(item?.author || "").trim(),
    license: String(item?.license || "").trim(),
    homepage: String(item?.homepage || "").trim(),
    tags: list(item?.tags),
    requirements: list(item?.requirements),
    authProfiles: list(item?.auth_profiles),
    totalBytes: Number(item?.total_bytes) || 0,
    fileCount: item?.files && typeof item.files === "object" ? Object.keys(item.files).length : 0,
    installed: item?.installed === true,
    installedVersion: String(item?.installed_version || "").trim(),
    updateAvailable: item?.update_available === true,
  };
}

// Case-insensitive match on name, id, description and tags.
function filterSkills(items, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items.filter((item) =>
    [item.name, item.id, item.description, ...(item.tags || [])].some((field) => String(field || "").toLowerCase().includes(needle)),
  );
}

export { filterSkills, normalizeInstallLink, normalizeStoreSkill, skillInstallTask, skillSourceInfo };
