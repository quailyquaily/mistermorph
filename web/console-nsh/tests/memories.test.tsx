import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

function memory(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    name: "tea",
    subject: "owner",
    type: "person",
    visibility: "private",
    description: "Likes tea",
    body: "Green tea, no sugar.",
    learned_in: "owner",
    updated_at: "2026-11-01T09:00:00Z",
    source_events: ["e1"],
    ...overrides,
  };
}

const ITEMS = [
  memory(),
  memory({ id: "m2", name: "short", subject: "general", type: "feedback", description: "Answer briefly", body: "Keep replies short.", source_events: [] }),
  memory({
    id: "m3",
    name: "bob-job",
    subject: "contact:tg:2",
    description: "Bob is a pilot",
    body: "Flies cargo.",
    told_by: "tg:3",
    learned_in: "contact:tg:3",
    visibility: "conversation",
  }),
];

const CONTACTS = {
  "GET /proxy:/contacts/list": {
    body: {
      items: [
        { contact_id: "tg:2", nickname: "Bob" },
        { contact_id: "tg:3", nickname: "Carol" },
      ],
    },
  },
};

function api(extra: Record<string, unknown> = {}) {
  return { ...CONTACTS, "GET /proxy:/memories": { body: { items: ITEMS } }, ...extra } as any;
}

test("the index groups subjects with counts; a subject shows its rules and facts; search filters", async () => {
  const { app } = await openConsole({ location: "/e/default/memories", api: api() });
  await app.waitFor("id:memories-subject:all");
  await app.waitFor("text:All memories");
  // All memories: a section per subject, contacts by their names.
  expect(app.shows("text:Likes tea")).toBe(true);
  await app.waitFor("id:memories-subject:contact:tg:2");
  await app.waitFor("text:Bob");
  expect(app.shows("text:/^owner$/i >> nth=0")).toBe(true);
  // A contact's claim about someone else is marked as theirs.
  expect(app.texts()).toContain("Carol says: Flies cargo.");

  await app.press("id:memories-subject:general");
  await app.waitFor("text:How the agent works with everyone.");
  expect(app.shows("text:Rules")).toBe(true);
  expect(app.shows("text:Likes tea")).toBe(false);

  await app.press("id:memories-subject:all");
  await app.type("id:memories-search", "pilot");
  await app.waitFor("text:Likes tea", { state: "gone" });
  expect(app.shows("text:Bob is a pilot")).toBe(true);
  await app.type("id:memories-search", "zzz");
  await app.waitFor("text:No memories match.");
  await app.press("id:memories-clear-filters");
  await app.waitFor("text:Likes tea");
});

test("a memory opens; its visibility changes, public only after a confirmation; a failed change says why", async () => {
  const puts: any[] = [];
  let fail = false;
  const { app } = await openConsole({
    location: "/e/default/memories?subject=owner",
    api: api({
      "PUT /proxy:/memories": (request: any) => {
        if (fail) return { status: 500, body: { error: "store is read-only" } };
        puts.push(request.json);
        return { body: { item: memory({ visibility: request.json.visibility }) } };
      },
    }),
  });
  await app.waitFor("id:memory-head:m1");
  await app.press("id:memory-head:m1");
  await app.waitFor("text:Who may hear it");
  await app.press("id:memory-visibility:m1:conversation");
  await app.waitUntil(() => puts.length === 1);
  expect(puts[0]).toEqual({ id: "m1", visibility: "conversation" });
  await app.waitFor("text:You, the conversation it came from, and the person it is about or who said it.");

  await app.press("id:memory-visibility:m1:public");
  await app.waitFor("text:Every DM and every group will hear this.");
  expect(puts.length).toBe(1);
  await app.press("id:memory-public-cancel");
  await app.waitFor("text:Every DM and every group will hear this.", { state: "gone" });
  await app.press("id:memory-visibility:m1:public");
  await app.press("id:memory-public-confirm");
  await app.waitUntil(() => puts.length === 2);
  expect(puts[1]).toEqual({ id: "m1", visibility: "public" });

  fail = true;
  await app.press("id:memory-visibility:m1:private");
  await app.waitFor("text:store is read-only");
});

test("a memory is edited in a dialog; an invalid draft cannot be saved; a failed save stays open", async () => {
  let put: any = null;
  let refuse = true;
  const { app } = await openConsole({
    location: "/e/default/memories?subject=owner",
    api: api({
      "PUT /proxy:/memories": (request: any) => {
        put = request.json;
        if (refuse) return { status: 409, body: { error: "changed elsewhere" } };
        return { body: { item: memory({ description: request.json.description, body: request.json.body }) } };
      },
    }),
  });
  await app.press("id:memory-head:m1");
  await app.press("id:memory-edit:m1");
  await app.waitFor("id:memory-edit-dialog");
  expect(app.value("id:memory-edit-description")).toBe("Likes tea");
  await app.clear("id:memory-edit-description");
  expect(app.enabled("id:memory-edit-save")).toBe(false);
  await app.type("id:memory-edit-description", "  Loves tea ");
  await app.press("id:memory-edit-save");
  await app.waitFor("text:changed elsewhere");
  expect(put).toEqual({ id: "m1", type: "person", description: "Loves tea", body: "Green tea, no sugar.", visibility: "private" });

  refuse = false;
  await app.press("id:memory-edit-save");
  await app.waitFor("id:memory-edit-dialog", { state: "gone" });
  await app.waitFor("text:Loves tea");
});

test("Forget asks first, then deletes; a failed delete keeps the memory and says why", async () => {
  let deleted = "";
  let fail = true;
  const { app } = await openConsole({
    location: "/e/default/memories?subject=owner",
    api: api({
      "DELETE /proxy:/memories": (request: any) => {
        if (fail) return { status: 500, body: { error: "cannot delete" } };
        deleted = new URLSearchParams(request.uri.split("?")[1]).get("id") || "";
        return { body: {} };
      },
    }),
  });
  await app.press("id:memory-head:m1");
  await app.press("id:memory-forget:m1");
  await app.waitFor("text:Delete “Likes tea”? The agent will no longer know it.");
  await app.press("id:dialog-action-delete");
  await app.waitFor("text:cannot delete");
  expect(app.shows("id:memory:m1")).toBe(true);

  fail = false;
  await app.press("id:memory-forget:m1");
  await app.press("id:dialog-action-delete");
  await app.waitUntil(() => deleted === "m1");
  await app.waitFor("id:memory:m1", { state: "gone" });
});

test("the journal searches; a memory's sources show its events and lead back", async () => {
  const searches: string[] = [];
  const { app } = await openConsole({
    location: "/e/default/memories?subject=owner",
    api: api({
      "GET /proxy:/journal/search": (request: any) => {
        searches.push(request.uri);
        return {
          body: {
            events: [
              { id: "e1", seq: 1, time: "2026-11-01T08:59:00Z", text: "I like green tea", audience: "owner", trace: { topic_id: "t1", runtime: "console", task_id: "task-1" } },
            ],
            has_more: request.uri.includes("q=tea"),
          },
        };
      },
    }),
  });
  await app.press("id:memory-head:m1");
  await app.press("id:memory-sources:m1");
  await app.waitFor("text:I like green tea");
  expect(searches[0]).toContain("ids=e1");
  expect(app.shows("text:Where the agent learned “Likes tea”")).toBe(true);
  await app.press("id:journal-back-to-memory");
  await app.waitFor("text:Who may hear it");

  await app.press("id:memories-journal");
  await app.waitFor("id:journal-search");
  await app.type("id:journal-search", "tea");
  await app.press("id:journal-go");
  await app.waitUntil(() => searches.length === 2);
  expect(searches[1]).toContain("q=tea");
  expect(searches[1]).toContain("limit=50");
  await app.waitFor("text:More events match; narrow the search.");
  // The event points back to the memory it led to.
  await app.press("text:Remembered as “Likes tea”");
  await app.waitFor("text:Who may hear it");
});

test("an empty journal search says so; a failed one shows the error", async () => {
  let fail = false;
  const { app } = await openConsole({
    location: "/e/default/memories",
    api: api({
      "GET /proxy:/journal/search": () => (fail ? { status: 500, body: { error: "journal offline" } } : { body: { events: [] } }),
    }),
  });
  await app.press("id:memories-journal");
  await app.waitFor("text:The raw record of what was asked and answered");
  await app.press("id:journal-go");
  await app.waitFor("text:Nothing in the journal matches.");
  fail = true;
  await app.press("id:journal-go");
  await app.waitFor("text:journal offline");
});

test("no memories says so; a failed load shows the error", async () => {
  const empty = await openConsole({ location: "/e/default/memories", api: api({ "GET /proxy:/memories": { body: { items: [] } } }) });
  await empty.app.waitFor("text:No memories yet. The agent saves them as it learns things worth keeping.");

  const broken = await openConsole({
    location: "/e/default/memories",
    api: api({ "GET /proxy:/memories": { status: 500, body: { error: "memories unavailable" } } }),
  });
  await broken.app.waitFor("text:memories unavailable");
});

test("a link to a contact's subject opens on it, on a phone too, with a back button", async () => {
  const { app } = await openConsole({ location: "/e/default/memories?subject=contact:tg:2", width: 420, api: api() });
  await app.waitFor("text:Bob is a pilot");
  expect(app.shows("id:memories-index")).toBe(false);
  await app.press("id:mobile-back");
  await app.waitFor("id:memories-index");
});
