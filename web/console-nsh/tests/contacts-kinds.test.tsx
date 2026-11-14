// The Contacts page's two icon tabs (ContactKindTabs): humans (the page opens on them) and agents,
// named only for assistive tech and tooltips; each lists its contacts by their recorded last
// interaction, newest first, again after every reload; switching keeps the filter's text and drops
// a contact of the other kind (and its editor); every action stays on both kinds; an empty tab says
// so. On a desktop and a phone. The ordering rules themselves: tests/contact-order.test.tsx; the
// tabs' geometry: tests/contact-kind-tabs.test.tsx.
import { expect, test, type App } from "nsh/test";
import { openConsole } from "./harness";

type Item = Record<string, unknown> & { contact_id: string; nickname: string };

const human = (id: string, nickname: string, last?: string, extra: Record<string, unknown> = {}): Item => ({
  contact_id: `tg:${id}`,
  nickname,
  kind: "human",
  channel: "telegram",
  status: "active",
  ...(last === undefined ? {} : { last_interaction_at: last }),
  ...extra,
});
const agent = (id: string, nickname: string, last?: string): Item => ({
  contact_id: `mm:${id}`,
  nickname,
  kind: "agent",
  channel: "console",
  status: "active",
  ...(last === undefined ? {} : { last_interaction_at: last }),
});

// Humans, newest first: Ivan; Jun and Kim at one instant (written in two zones), by id; Hana; then
// Max (an unreadable time) and Lee (none, though created and updated last) by id. Nina has no kind.
const HUMANS = [
  human("2001", "Hana", "2026-01-05T10:00:00Z"),
  human("2005", "Lee", undefined, { created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:00:00Z" }),
  human("2004", "Kim", "2026-11-12T00:00:00Z"),
  human("2002", "Ivan", "2026-11-13T10:00:00.5Z"),
  human("2000", "Max", "last tuesday"),
  human("2003", "Jun", "2026-11-12T09:00:00+09:00"),
  { contact_id: "slack:T1:U7", nickname: "Nina", channel: "slack", status: "active", last_interaction_at: "2025-06-01T00:00:00Z" },
];
const HUMAN_ORDER = ["Ivan", "Jun", "Kim", "Hana", "Nina", "Max", "Lee"];
const AGENTS = [agent("a1", "Atlas", "2026-11-01T00:00:00Z"), agent("a3", "Cog"), agent("a2", "Bolt", "2026-11-14T08:00:00Z")];
const AGENT_ORDER = ["Bolt", "Atlas", "Cog"];
const NAMES = new Set([...HUMAN_ORDER, ...AGENT_ORDER]);

// A phone: the Android app (touch: its filter waits above the list until a pull shows it).
const DESKTOP = { width: 1280 } as const;
const PHONE = { platform: "android", width: 390 } as const;
type Layout = typeof DESKTOP | typeof PHONE;
const LAYOUTS = [
  { name: "desktop", options: DESKTOP },
  { name: "phone", options: PHONE },
] as const;

/** The contacts' titles in the index, top to bottom (a desktop's open card repeats one: the index's comes first). */
function listed(app: App): string[] {
  const seen: string[] = [];
  for (const text of app.texts()) if (NAMES.has(text) && !seen.includes(text)) seen.push(text);
  return seen;
}

function expectTab(app: App, kind: "human" | "agent") {
  const other = kind === "human" ? "agent" : "human";
  expect(app.shows(`id:contacts-tab-${kind}-selected`)).toBe(true);
  expect(app.shows(`id:contacts-tab-${other}-idle`)).toBe(true);
  expect(app.shows(`id:contacts-tab-${kind}-idle`)).toBe(false);
  expect(app.shows(`id:contacts-tab-${other}-selected`)).toBe(false);
}

async function openContacts(layout: Layout, items: () => unknown[], api: Record<string, unknown> = {}) {
  return openConsole({
    location: "/e/default/contacts",
    ...layout,
    api: {
      "GET /proxy:/contacts/list": () => ({ body: { items: items() } }),
      "GET /proxy:/memories": { body: { items: [] } },
      ...(api as any),
    },
  });
}

for (const layout of LAYOUTS) {
  test(`${layout.name}: icon tabs split humans from agents, each newest interaction first`, async () => {
    const { app } = await openContacts(layout.options, () => [...HUMANS, ...AGENTS]);
    await app.waitFor("id:contact-row:tg:2002");
    // Two tabs named for assistive tech, with no visible label.
    expect(app.count("label:Humans")).toBe(1);
    expect(app.count("label:Agents")).toBe(1);
    expect(app.texts().some((text) => text === "Humans" || text === "Agents")).toBe(false);
    expectTab(app, "human");
    expect(listed(app)).toEqual(HUMAN_ORDER);
    expect(app.shows("id:contact-row:mm:a2")).toBe(false);

    await app.press("label:Agents");
    await app.waitFor("id:contact-row:mm:a2");
    await app.waitFor("id:contact-row:tg:2002", { state: "gone" });
    expectTab(app, "agent");
    expect(listed(app)).toEqual(AGENT_ORDER);

    // Pressing the current tab changes nothing.
    await app.press("id:contacts-tab-agent");
    expectTab(app, "agent");
    expect(listed(app)).toEqual(AGENT_ORDER);

    await app.press("id:contacts-tab-human");
    await app.waitFor("id:contact-row:tg:2002");
    expectTab(app, "human");
    expect(listed(app)).toEqual(HUMAN_ORDER);
  });

  test(`${layout.name}: the filter keeps its text across the tabs and filters each`, async () => {
    const { app } = await openContacts(layout.options, () => [...HUMANS, ...AGENTS]);
    await app.waitFor("id:contact-row:tg:2002");
    if (layout.name === "phone") {
      // A phone's filter waits above the list until it is pulled down (pull-search.test.tsx).
      await app.drag("id:contacts-list", { x: 0, y: 220 });
    }
    await app.waitFor("id:contacts-filter");
    // Only Bolt's name holds "bo": no human matches it.
    await app.type("id:contacts-filter", "bo");
    await app.waitFor("text:No matching contacts");
    await app.press("id:contacts-tab-agent");
    await app.waitFor("id:contact-row:mm:a2");
    expect(app.value("id:contacts-filter")).toBe("bo");
    expect(listed(app)).toEqual(["Bolt"]);
    // A filter matching some contacts of each kind ("Console" is every agent's channel).
    await app.clear("id:contacts-filter");
    await app.type("id:contacts-filter", "o");
    await app.waitFor("id:contact-row:mm:a1");
    expect(listed(app)).toEqual(AGENT_ORDER);
    await app.clear("id:contacts-filter");
    await app.type("id:contacts-filter", "bo");
    await app.press("id:contacts-tab-human");
    await app.waitFor("text:No matching contacts");
    expect(app.value("id:contacts-filter")).toBe("bo");
    await app.clear("id:contacts-filter");
    await app.waitFor("id:contact-row:tg:2002");
    expect(listed(app)).toEqual(HUMAN_ORDER);
  });

  test(`${layout.name}: an empty tab says which kind it has none of`, async () => {
    let items: unknown[] = HUMANS;
    const { app } = await openContacts(layout.options, () => items);
    await app.waitFor("id:contact-row:tg:2002");
    await app.press("id:contacts-tab-agent");
    await app.waitFor("text:No agent contacts");
    expect(app.shows("id:contacts-empty")).toBe(true);
    expect(listed(app)).toEqual([]);

    // Only agents: the page opens on its empty Humans tab, the agents one tab away.
    items = AGENTS;
    const agentsOnly = (await openContacts(layout.options, () => items)).app;
    await agentsOnly.waitFor("text:No human contacts");
    expectTab(agentsOnly, "human");
    await agentsOnly.press("label:Agents");
    await agentsOnly.waitFor("id:contact-row:mm:a1");
    expect(listed(agentsOnly)).toEqual(AGENT_ORDER);

    // None at all: both tabs say there are no contacts.
    const none = (await openContacts(layout.options, () => [])).app;
    await none.waitFor("text:No contacts");
    await none.press("id:contacts-tab-agent");
    await none.waitFor("text:No contacts");
    expectTab(none, "agent");
  });
}

test("desktop: leaving a tab closes its open contact and editor; the other kind's contact keeps every action", async () => {
  let items: Item[] = [...HUMANS, ...AGENTS];
  let deleted = "";
  const { app } = await openContacts(DESKTOP, () => items, {
    "GET /proxy:/contacts/item": { body: { yaml: "nickname: Ivan\n" } },
    "DELETE /proxy:/contacts/item": (request: { uri?: string }) => {
      deleted = new URLSearchParams(request.uri!.split("?")[1]).get("contact_id") || "";
      items = items.filter((item) => item.contact_id !== deleted);
      return { body: {} };
    },
  });
  await app.press("id:contact-row:tg:2002");
  await app.waitFor("id:contact-detail");
  expect(app.shows("id:contact-owner")).toBe(true);
  await app.press("id:contact-edit");
  await app.waitFor("id:contact-yaml");

  await app.press("id:contacts-tab-agent");
  await app.waitFor("id:contact-yaml", { state: "gone" });
  await app.waitFor("id:contact-detail", { state: "gone" });
  expect(app.shows("text:No contact selected")).toBe(true);

  // An agent: its card, YAML editing, copying and the delete menu, as a human's (no owner switch,
  // as before the tabs).
  await app.press("id:contact-row:mm:a3");
  await app.waitFor("text:Agent · Console");
  expect(app.shows("id:contact-owner")).toBe(false);
  await app.press("id:contact-copy-id");
  await app.waitFor("text:Copied to clipboard");
  expect(app.clipboard()).toBe("mm:a3");
  await app.press("id:contact-edit");
  await app.waitFor("id:contact-yaml");
  await app.press("id:contact-edit-cancel");
  await app.waitFor("id:contact-yaml", { state: "gone" });
  await app.press("id:contact-actions");
  await app.press("role:menuitem[Delete]");
  await app.press("id:dialog-action-delete");
  await app.waitUntil(() => deleted === "mm:a3");
  // The reload keeps the tab, without the deleted agent.
  await app.waitFor("id:contact-row:mm:a3", { state: "gone" });
  expectTab(app, "agent");
  expect(listed(app)).toEqual(["Bolt", "Atlas"]);
  expect(app.shows("text:No contact selected")).toBe(true);

  // Back on Humans, nothing of the agent is open, and Ivan's editor did not come back.
  await app.press("id:contacts-tab-human");
  await app.waitFor("id:contact-row:tg:2002");
  expect(app.shows("id:contact-detail")).toBe(false);
  expect(app.shows("id:contact-yaml")).toBe(false);
});

test("desktop: a reload sorts the tab again by the new interaction times", async () => {
  let items: Item[] = [...HUMANS, ...AGENTS];
  const { app } = await openContacts(DESKTOP, () => items, {
    "PATCH /proxy:/contacts/item": (request: { json: { contact_id: string; owner: boolean } }) => {
      // Hana writes again as she is marked the owner's: she is the latest interaction now.
      items = items.map((item) =>
        item.contact_id === request.json.contact_id ? { ...item, owner: request.json.owner, last_interaction_at: "2026-11-14T12:00:00Z" } : item,
      );
      return { body: {} };
    },
    "GET /proxy:/contacts/item": { body: { yaml: "nickname: Max\nkind: agent\n" } },
    "PUT /proxy:/contacts/item": (request: { json: { contact_id: string } }) => {
      // Max becomes an agent, with a recorded interaction.
      items = items.map((item) =>
        item.contact_id === request.json.contact_id ? { ...item, kind: "agent", last_interaction_at: "2026-11-02T00:00:00Z" } : item,
      );
      return { body: {} };
    },
  });
  await app.waitFor("id:contact-row:tg:2001");
  expect(listed(app)).toEqual(HUMAN_ORDER);
  await app.press("id:contact-row:tg:2001");
  await app.press("id:contact-owner");
  await app.waitFor("text:Saved");
  await app.waitUntil(() => listed(app)[0] === "Hana");
  expect(listed(app)).toEqual(["Hana", "Ivan", "Jun", "Kim", "Nina", "Max", "Lee"]);

  // A save that makes a human an agent moves it, and the page, to the Agents tab, in its place there.
  await app.press("id:contact-row:tg:2000");
  await app.press("id:contact-edit");
  await app.waitFor("id:contact-yaml");
  await app.type("id:contact-yaml", "\n");
  await app.press("id:contact-edit-save");
  await app.waitFor("id:contact-yaml", { state: "gone" });
  await app.waitFor("id:contacts-tab-agent-selected");
  expect(listed(app)).toEqual(["Bolt", "Max", "Atlas", "Cog"]);
  expect(app.shows("text:Agent · Telegram")).toBe(true);
});

test("phone: an agent opens from its tab and the index comes back on it", async () => {
  const { app } = await openContacts(PHONE, () => [...HUMANS, ...AGENTS]);
  await app.waitFor("id:contact-row:tg:2002");
  await app.press("id:contacts-tab-agent");
  await app.press("id:contact-row:mm:a2");
  await app.waitFor("id:contact-detail");
  await app.waitFor("id:contacts-index", { state: "gone" });
  expect(app.shows("text:Agent · Console")).toBe(true);
  await app.press("id:mobile-back");
  await app.waitFor("id:contacts-index");
  expectTab(app, "agent");
  expect(listed(app)).toEqual(AGENT_ORDER);
});
