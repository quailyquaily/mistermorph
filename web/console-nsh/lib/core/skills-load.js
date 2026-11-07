// skills.load semantics shared by the Skills page: an empty list (or "*") loads every
// discovered skill; otherwise it names skills by id or name, case-insensitively.

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = trimText(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function skillLoadEntry(skill) {
  return trimText(skill?.id) || trimText(skill?.name);
}

export function skillLoadEntryMatches(skill, entry) {
  const key = trimText(entry).toLowerCase();
  if (!key) {
    return false;
  }
  return trimText(skill?.id).toLowerCase() === key || trimText(skill?.name).toLowerCase() === key;
}

export function loadsAllSkills(load) {
  const entries = uniqueNames(load);
  return entries.length === 0 || (entries.length === 1 && entries[0] === "*");
}

// The load list after switching one skill on or off. Starting from "all", switching one off
// lists every other skill; a list that ends up naming every skill collapses back to [] (all).
// An empty result for a switch-off means "none", which callers must express another way
// (see skillToggleSettings).
export function nextSkillLoad(load, skills, skill, loaded) {
  const all = (Array.isArray(skills) ? skills : []).filter((item) => skillLoadEntry(item));
  const target = skillLoadEntry(skill);
  if (!target) {
    return uniqueNames(load);
  }
  let entries = loadsAllSkills(load)
    ? uniqueNames(all.map((item) => skillLoadEntry(item)))
    : uniqueNames(load).filter((entry) => entry !== "*");
  if (loaded) {
    if (!entries.some((entry) => skillLoadEntryMatches(skill, entry))) {
      entries.push(target);
    }
  } else {
    entries = entries.filter((entry) => !skillLoadEntryMatches(skill, entry));
  }
  const coversAll = all.length > 0 && all.every((item) => entries.some((entry) => skillLoadEntryMatches(item, entry)));
  return coversAll ? [] : entries;
}

// The skills settings after switching one skill on or off: { enabled, load }. The load list
// cannot say "none" (empty means all), so switching off the last loaded skill turns skills off
// and keeps the list; switching one on while skills are off turns them on with just that one.
export function skillToggleSettings(settings, skills, skill, loaded) {
  const enabled = settings?.enabled !== false;
  const load = uniqueNames(settings?.load);
  if (loaded && !enabled) {
    return { enabled: true, load: nextSkillLoad([skillLoadEntry(skill)], skills, skill, true) };
  }
  if (!enabled) {
    return { enabled, load };
  }
  const next = nextSkillLoad(load, skills, skill, loaded);
  if (!loaded && next.length === 0) {
    return { enabled: false, load };
  }
  return { enabled: true, load: next };
}
