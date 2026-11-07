// The Memories page's grouping, in plain functions so they can be tested without the page
// (docs/feat/feat_20261027_memories.md). Who may hear a memory is never decided here: the runtime
// answers that (GET /memories?hear_as=…).

// subjectKind is the kind of a subject or an audience: owner, general, contact or conversation.
function subjectKind(value) {
  const text = String(value || "");
  if (text === "owner" || text === "general") return text;
  if (text.startsWith("contact:")) return "contact";
  if (text.startsWith("conversation:")) return "conversation";
  return "";
}

// subjectID is what follows the kind: a contact ID or a conversation key.
function subjectID(value) {
  const text = String(value || "");
  const cut = text.indexOf(":");
  return cut < 0 ? "" : text.slice(cut + 1);
}

const KIND_ORDER = { owner: 0, general: 1, contact: 2, conversation: 3 };

function compareSubjects(a, b) {
  return (KIND_ORDER[subjectKind(a)] ?? 4) - (KIND_ORDER[subjectKind(b)] ?? 4) || String(a).localeCompare(String(b));
}

// isRule: a feedback memory changes how the agent behaves, so the page lists it before facts.
function isRule(memory) {
  return memory?.type === "feedback";
}

function rulesFirst(list) {
  return [...list].sort((a, b) => Number(isRule(b)) - Number(isRule(a)));
}

// subjectsOf lists the subjects that have memories, and the always ones even without, in page
// order, with how many each has.
function subjectsOf(items, always = []) {
  const counts = new Map(always.map((subject) => [subject, 0]));
  for (const item of items || []) {
    const subject = String(item?.subject || "");
    if (subject) counts.set(subject, (counts.get(subject) || 0) + 1);
  }
  return Array.from(counts.keys())
    .sort(compareSubjects)
    .map((subject) => ({ subject, kind: subjectKind(subject), count: counts.get(subject) }));
}

// isClaim: a memory a contact told about someone else is that contact's claim, not a known fact.
function isClaim(memory) {
  const toldBy = String(memory?.told_by || "");
  return toldBy !== "" && memory?.subject !== `contact:${toldBy}`;
}

function matchesQuery(memory, needle, labels = []) {
  const query = String(needle || "").trim().toLowerCase();
  if (!query) return true;
  return [memory?.name, memory?.description, memory?.body, memory?.told_by, ...labels]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

// memorySections groups what the page shows: one section per subject, rules first, for all
// subjects; Rules then Facts for one.
function memorySections(items, subject) {
  const list = items || [];
  if (!subject) {
    const bySubject = new Map();
    for (const item of list) {
      if (!bySubject.has(item.subject)) bySubject.set(item.subject, []);
      bySubject.get(item.subject).push(item);
    }
    return Array.from(bySubject.keys())
      .sort(compareSubjects)
      .map((key) => ({ key, subject: key, items: rulesFirst(bySubject.get(key)) }));
  }
  const mine = list.filter((item) => item.subject === subject);
  return [
    { key: "rules", items: mine.filter(isRule) },
    { key: "facts", items: mine.filter((item) => !isRule(item)) },
  ].filter((section) => section.items.length > 0);
}

// journalDays groups journal events, newest first, by local day.
function journalDays(events, dayOf) {
  const days = [];
  for (const event of events || []) {
    const label = dayOf(event.time);
    let day = days[days.length - 1];
    if (!day || day.label !== label) {
      day = { label, events: [] };
      days.push(day);
    }
    day.events.push(event);
  }
  return days;
}

export {
  isClaim,
  isRule,
  journalDays,
  matchesQuery,
  memorySections,
  subjectID,
  subjectKind,
  subjectsOf,
};
