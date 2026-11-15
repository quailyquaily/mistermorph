import { expect, test } from "nsh/test";
import { localEndpoint, openConsole } from "./harness";

const AGENT_INSTANCE = `inst_${"a".repeat(32)}`;
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const ALICE = {
  contact_id: "tg:1001",
  nickname: "Alice",
  kind: "human",
  channel: "telegram",
  tg_username: "alice",
  status: "active",
  avatar_url: "/contacts/avatar?contact_id=tg:1001",
  last_interaction_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
};
const BOT = { contact_id: `mm:${AGENT_INSTANCE}`, nickname: "Helper", kind: "agent", channel: "console", status: "active" };
const NAMELESS = { contact_id: "slack:T1:U99", kind: "human", channel: "slack", status: "inactive" };
// More people, after Alice in the library (the same last interaction: by their ids).
const CAROL = { ...ALICE, contact_id: "tg:1003", nickname: "Carol", tg_username: "carol", avatar_url: "" };
const DAVE = { ...ALICE, contact_id: "tg:1004", nickname: "Dave", tg_username: "dave", avatar_url: "" };

function list(items: unknown[]) {
  return { "GET /proxy:/contacts/list": () => ({ body: { items } }) };
}

test("the library shows a card per contact, filters them, and a pick opens the contact with its connections", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/contacts",
    api: {
      ...list([ALICE, BOT, NAMELESS]),
      "GET /proxy:/memories": { body: { items: [{ id: "m1", description: "Likes tea", body: "Green, no sugar." }] } },
      "GET /proxy/download:/contacts/avatar": { body: "not really an image" },
    },
  });
  await app.waitFor("id:contact-row:tg:1001");
  // A card: the name, the kind, and the handle under the channel's logo.
  expect(app.shows("id:contact-row:tg:1001 >> text:Alice")).toBe(true);
  expect(app.shows("id:contact-row:tg:1001 >> text:HUMAN")).toBe(true);
  expect(app.shows("id:contact-row:tg:1001 >> text:@alice")).toBe(true);
  // Without a name, the handle is the title and "Unnamed User" takes the handle's place.
  expect(app.shows("id:contact-row:slack:T1:U99 >> text:U99")).toBe(true);
  expect(app.shows("id:contact-row:slack:T1:U99 >> text:Unnamed User")).toBe(true);
  // Nothing picked: no panel, the library takes the page.
  expect(app.shows("id:contact-detail")).toBe(false);
  await app.waitUntil(() => calls.some((call) => call.uri === "/contacts/avatar?contact_id=tg:1001"));

  await app.type("id:contacts-filter", "helper");
  await app.waitFor("id:contact-row:tg:1001", { state: "gone" });
  await app.type("id:contacts-filter", "zzz");
  await app.waitFor("text:No matching contacts");
  await app.clear("id:contacts-filter");

  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail");
  expect(app.shows("text:HUMAN · TELEGRAM")).toBe(true);
  expect(app.shows("text:@alice")).toBe(true);
  // "2 hours ago" where Intl.RelativeTimeFormat exists (browsers); the full time on QuickJS.
  expect(app.shows("text:No interactions yet")).toBe(false);
  await app.waitFor("text:Likes tea");
  expect(calls.some((call) => call.uri === "/memories?subject=contact%3Atg%3A1001")).toBe(true);

  await app.press("id:contact-copy-id");
  await app.waitFor("text:Copied to clipboard");
  expect(app.clipboard()).toBe("tg:1001");
});

test("an Agent Link contact shows its agent's avatar and no owner switch", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/contacts",
    endpoints: [localEndpoint(), localEndpoint({ endpoint_ref: "ep_helper", name: "Helper", instance_id: AGENT_INSTANCE, avatar_url: PIXEL })],
    api: { ...list([{ ...BOT, avatar_url: "/contacts/avatar?contact_id=bot" }]), "GET /proxy:/memories": { body: { items: [] } } },
  });
  // Agents have a tab of their own (tests/contacts-kinds.test.tsx).
  await app.press("id:contacts-tab-agent");
  await app.press("id:contact-row:" + BOT.contact_id);
  await app.waitFor("id:contact-detail");
  expect(app.shows("text:AGENT · CONSOLE")).toBe(true);
  expect(app.shows("id:contact-owner")).toBe(false);
  expect(app.shows("text:Primary channel")).toBe(true);
  await app.waitFor("text:The agent has no memories about this contact.");
  // Its avatar is the endpoint's, which wins over its own: nothing is downloaded.
  expect(calls.some((call) => call.path === "/proxy/download" && call.uri?.startsWith("/contacts"))).toBe(false);
});

test("the owner switch saves with PATCH; a failure says why", async () => {
  let patched: any = null;
  let owner = false;
  let fail = false;
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: {
      "GET /proxy:/contacts/list": () => ({ body: { items: [{ ...ALICE, avatar_url: "", owner }] } }),
      "GET /proxy:/memories": { body: { items: [] } },
      "PATCH /proxy:/contacts/item": (request) => {
        if (fail) return { status: 500, body: { error: "read-only contacts file" } };
        patched = request.json;
        owner = request.json.owner;
        return { body: {} };
      },
    },
  });
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-owner");
  await app.press("id:contact-owner");
  await app.waitUntil(() => patched !== null);
  expect(patched).toEqual({ contact_id: "tg:1001", owner: true });
  await app.waitFor("text:Saved");

  fail = true;
  await app.press("id:contact-owner");
  await app.waitFor("text:read-only contacts file");
});

test("Edit YAML loads the block, saves it with PUT, and keeps the editor on a refused save", async () => {
  let put: any = null;
  let refuse = true;
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: {
      ...list([{ ...ALICE, avatar_url: "" }]),
      "GET /proxy:/memories": { body: { items: [] } },
      "GET /proxy:/contacts/item": { body: { yaml: "nickname: Alice\n" } },
      "PUT /proxy:/contacts/item": (request) => {
        put = request.json;
        return refuse ? { status: 400, body: { error: "invalid yaml" } } : { body: {} };
      },
    },
  });
  await app.press("id:contact-row:tg:1001");
  await app.press("id:contact-edit");
  await app.waitFor("id:contact-yaml");
  expect(app.value("id:contact-yaml")).toBe("nickname: Alice");
  expect(app.enabled("id:contact-edit-save")).toBe(false);
  await app.type("id:contact-yaml", "\nnote: hi");
  await app.press("id:contact-edit-save");
  await app.waitFor("text:invalid yaml");
  expect(put).toEqual({ contact_id: "tg:1001", yaml: "nickname: Alice\nnote: hi" });
  expect(app.shows("id:contact-yaml")).toBe(true);

  refuse = false;
  await app.press("id:contact-edit-save");
  await app.waitFor("id:contact-yaml", { state: "gone" });
  await app.waitFor("text:Saved");
});

test("a failed YAML read shows the error in the editor; Cancel leaves", async () => {
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: {
      ...list([{ ...ALICE, avatar_url: "" }]),
      "GET /proxy:/memories": { body: { items: [] } },
      "GET /proxy:/contacts/item": { status: 500, body: { error: "cannot read contacts" } },
    },
  });
  await app.press("id:contact-row:tg:1001");
  await app.press("id:contact-edit");
  await app.waitFor("text:cannot read contacts");
  await app.press("id:contact-edit-cancel");
  await app.waitFor("id:contact-edit");
});

test("a contact is deleted through its menu; a failed delete is reported", async () => {
  let deleted = "";
  let fail = true;
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: {
      "GET /proxy:/contacts/list": () => ({ body: { items: deleted ? [] : [{ ...ALICE, avatar_url: "" }] } }),
      "GET /proxy:/memories": { body: { items: [] } },
      "DELETE /proxy:/contacts/item": (request) => {
        if (fail) return { status: 500, body: { error: "locked" } };
        deleted = new URLSearchParams(request.uri!.split("?")[1]).get("contact_id") || "";
        return { body: {} };
      },
    },
  });
  await app.press("id:contact-row:tg:1001");
  await app.press("id:contact-actions");
  await app.press("role:menuitem[Delete]");
  await app.waitFor('text:Delete contact "Alice"? This removes the profile block from its source file.');
  await app.press("id:dialog-action-delete");
  await app.waitFor("text:locked");

  fail = false;
  await app.press("id:contact-actions");
  await app.press("role:menuitem[Delete]");
  await app.press("id:dialog-action-delete");
  await app.waitUntil(() => deleted === "tg:1001");
  await app.waitFor("text:No contacts");
  await app.waitFor("id:contact-detail", { state: "gone" });
});

test("Open in Memories goes to the contact's memories", async () => {
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: { ...list([{ ...ALICE, avatar_url: "" }]), "GET /proxy:/memories": { body: { items: [] } } },
  });
  await app.press("id:contact-row:tg:1001");
  await app.press("id:contact-open-memories");
  await app.waitFor("id:memories-page");
});

test("a failed list shows the error; an empty list says so", async () => {
  const broken = await openConsole({
    location: "/e/default/contacts",
    api: { "GET /proxy:/contacts/list": { status: 500, body: { error: "contacts unavailable" } } },
  });
  await broken.app.waitFor("text:contacts unavailable");

  const empty = await openConsole({ location: "/e/default/contacts" });
  await empty.app.waitFor("text:No contacts");
});

test("on a phone the index and the card take turns", async () => {
  const { app } = await openConsole({
    location: "/e/default/contacts",
    width: 420,
    api: { ...list([{ ...ALICE, avatar_url: "" }]), "GET /proxy:/memories": { body: { items: [] } } },
  });
  await app.waitFor("id:contact-row:tg:1001");
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail");
  // The card slides in over the index, which goes once the slide has ended.
  await app.waitFor("id:contacts-index", { state: "gone" });
  await app.press("id:mobile-back");
  await app.waitFor("id:contacts-index");
});

test("on a desktop the panel opens beside the library and closes with its close button and Escape", async () => {
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: { ...list([{ ...ALICE, avatar_url: "" }, BOT, CAROL]), "GET /proxy:/memories": { body: { items: [] } } },
  });
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail");
  // The library stays beside it, the picked card selected.
  expect(app.shows("id:contacts-list")).toBe(true);
  expect(app.shows("id:contact-row:tg:1003")).toBe(true);
  await app.press("id:contact-close");
  await app.waitFor("id:contact-detail", { state: "gone" });

  // An agent's, from its tab (tests/contacts-kinds.test.tsx).
  await app.press("id:contacts-tab-agent");
  await app.press("id:contact-row:" + BOT.contact_id);
  await app.waitFor("text:AGENT · CONSOLE");
  await app.press("id:contacts-tab-human");
  await app.waitFor("id:contact-detail", { state: "gone" });
  await app.press("id:contact-row:tg:1003");
  await app.waitFor("id:contact-detail >> text:@carol");
  // Another card while it is open: the panel shows that contact.
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail >> text:@alice");
  await app.keyboard.press("escape");
  await app.waitFor("id:contact-detail", { state: "gone" });
});

test("on a desktop the arrows walk the cards and Enter opens one; with the panel open they open the next", async () => {
  // The agent is on its own tab: the arrows walk the people.
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: { ...list([{ ...ALICE, avatar_url: "" }, BOT, CAROL, DAVE]), "GET /proxy:/memories": { body: { items: [] } } },
  });
  await app.waitFor("id:contact-row:tg:1004");
  // The first arrow stands on the first card; Enter opens it.
  await app.keyboard.press("right");
  expect(app.shows("id:contact-detail")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor("text:HUMAN · TELEGRAM");
  await app.waitFor("id:contact-detail >> text:@alice");
  // Open, the arrows open the card they move to.
  await app.keyboard.press("right");
  await app.waitFor("id:contact-detail >> text:@carol");
  await app.keyboard.press("right");
  await app.waitFor("id:contact-detail >> text:@dave");
  // Past the last card it stays there.
  await app.keyboard.press("right");
  await app.wait(100);
  expect(app.shows("id:contact-detail >> text:@dave")).toBe(true);
  await app.keyboard.press("left");
  await app.waitFor("id:contact-detail >> text:@carol");
});

test("Send message hands the message to the agent as a task and opens its topic; a refusal stays in the dialog", async () => {
  let task = "";
  let refuse = true;
  const { app } = await openConsole({
    location: "/e/default/contacts",
    api: {
      ...list([{ ...ALICE, avatar_url: "" }]),
      "GET /proxy:/memories": { body: { items: [] } },
      "POST /proxy:/tasks": (request) => {
        task = request.json.task;
        return refuse ? { status: 500, body: { error: "queue full" } } : { body: { topic_id: "topic-send" } };
      },
    },
  });
  await app.press("id:contact-row:tg:1001");
  await app.press("id:contact-send");
  await app.waitFor("id:contact-send-text");
  // Nothing to send yet.
  expect(app.enabled("id:contact-send-submit")).toBe(false);
  await app.type("id:contact-send-text", "See you at 6");
  await app.press("id:contact-send-submit");
  await app.waitFor("text:queue full");
  // The task names the contact and carries the message word for word, for contacts_send.
  expect(task).toContain("contact_id: tg:1001");
  expect(task).toContain("$contacts_send");
  expect(task.endsWith("\n\nSee you at 6")).toBe(true);
  expect(app.shows("id:contact-send-text")).toBe(true);

  refuse = false;
  await app.press("id:contact-send-submit");
  await app.waitFor("id:contact-send-text", { state: "gone" });
  await app.waitFor("id:contacts-page", { state: "gone" });
});
