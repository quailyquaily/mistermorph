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

// Case-insensitive match on name, id and description.
function filterSkills(items, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items.filter((item) =>
    [item.name, item.id, item.description].some((field) => String(field || "").toLowerCase().includes(needle)),
  );
}

export { filterSkills, normalizeInstallLink, skillInstallTask, skillSourceInfo };
