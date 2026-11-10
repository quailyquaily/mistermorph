// Switching between Contacts and TODO on the phone app, again and again (the Android report:
// frozen after 14 round trips). Each switch rebuilds the page (pages/routes.tsx PageView), and the
// route guard selects the agent again, which reloads the contacts of a Contacts page on its way
// out. The phone's contact index once passed its List a function `empty` slot that read the
// store: nsh 0.4.0 never disposes that slot's scope, so every page that went away left one behind,
// re-rendering into the dead list on each load, and the 10th round trip hung the app for good (here,
// headless; 14 in the report). Both pages must stay usable through 50 round trips: with rows, with
// nothing, slow and failing.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { type ApiHandler, MOBILE_LOCATION_KEY, openConsole } from "./harness";

const CYCLES = 50;
/** 50 round trips take about a minute headless, over nsh's 30 s default. */
const TIMEOUT = 240_000;
const NOW = new Date().toISOString();

const CONTACTS = Array.from({ length: 12 }, (_, i) => ({
  contact_id: `tg:${1000 + i}`,
  nickname: `Person ${i}`,
  kind: "human",
  channel: "telegram",
  tg_username: `person${i}`,
  status: "active",
  last_interaction_at: NOW,
}));
const TASKS = Array.from({ length: 6 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}`, content: "Check it", cron: "15 9 * * 1", tz: "UTC" }));

function tasksBody(tasks: unknown[]) {
  return { tasks, system_tasks: [{ id: "__heartbeat__", cron: "*/30 * * * *" }], chat_options: [], llm_profiles: [], heartbeat_enabled: true, runs: [] };
}

function api(contacts: ApiHandler, tasks: ApiHandler): Record<string, ApiHandler> {
  return {
    "GET /proxy:/contacts/list": contacts,
    "GET /proxy:/todo/tasks": tasks,
    "GET /proxy:/todo/runs": { body: { runs: [] } },
    "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
    "GET /proxy:/memories": { body: { items: [] } },
    "GET /proxy:/tasks": { body: { items: [] } },
  };
}

/** Where the app is: the location the phone app saves for its next launch. */
const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");

async function toTodo(app: App, ready: string) {
  await app.press("id:mobile-nav-todo");
  await app.waitFor(ready);
  expect(location(app)).toBe("/e/default/todo");
}

async function toContacts(app: App, ready: string) {
  await app.press("id:mobile-nav-contacts");
  await app.waitFor(ready);
  expect(location(app)).toBe("/e/default/contacts");
}

test(`with contacts and TODOs, ${CYCLES} round trips keep both pages and their phone views working`, async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/contacts",
    api: api({ body: { items: CONTACTS } }, { body: tasksBody(TASKS) }),
  });
  await app.waitFor("id:contact-row:tg:1000");
  for (let i = 0; i < CYCLES; i += 1) {
    await toTodo(app, "id:todo-item-task-0");
    // A different task and contact each time: open it, then back to the list.
    const task = `task-${i % TASKS.length}`;
    await app.press(`id:todo-item-${task}`);
    await app.waitFor("id:todo-task-editor");
    await app.press("id:todo-back");
    await app.waitFor(`id:todo-item-${task}`);

    await toContacts(app, "id:contact-row:tg:1000");
    const contact = `tg:${1000 + (i % 5)}`;
    await app.press(`id:contact-row:${contact}`);
    await app.waitFor("id:contact-detail");
    expect(app.shows(`text:@person${i % 5}`)).toBe(true);
    // Android's Back closes the card (the page's own back), then the index lists the contacts again.
    await app.back();
    await app.waitFor(`id:contact-row:${contact}`);
  }
  // The pages still load what they show: one contacts list request for each Contacts page at least.
  expect(calls.filter((call) => call.uri === "/contacts/list").length).toBeGreaterThan(CYCLES);
  // And navigation still goes back through the places it went through.
  await app.back();
  await app.waitFor("id:todo-item-task-0");
  expect(location(app)).toBe("/e/default/todo");
}, TIMEOUT);

test(`with no contacts and no TODOs, ${CYCLES} round trips keep both empty pages working`, async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/contacts",
    api: api({ body: { items: [] } }, { body: tasksBody([]) }),
  });
  await app.waitFor("id:contacts-empty");
  for (let i = 0; i < CYCLES; i += 1) {
    await toTodo(app, "id:todo-empty-add");
    await toContacts(app, "id:contacts-empty");
  }
  expect(app.shows("text:No contacts")).toBe(true);
  // The empty TODO list still adds an item.
  await toTodo(app, "id:todo-empty-add");
  await app.press("id:todo-empty-add");
  await app.waitFor("id:todo-task-editor");
}, TIMEOUT);

test(`slow and failing loads, from a first load on TODO, survive ${CYCLES} round trips`, async () => {
  let contactLoads = 0;
  let taskLoads = 0;
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    api: api(
      // Every third contacts load fails; the others answer late.
      () => {
        contactLoads += 1;
        return contactLoads % 3 === 0
          ? { status: 500, body: { error: "contacts unavailable" }, delay: 40 }
          : { body: { items: CONTACTS.slice(0, 3) }, delay: 120 };
      },
      // Every other TODO load fails.
      () => {
        taskLoads += 1;
        return taskLoads % 2 === 0 ? { status: 500, body: { error: "agent offline" }, delay: 60 } : { body: tasksBody(TASKS), delay: 90 };
      },
    ),
  });
  await app.waitFor("id:todo-item-task-0");
  for (let i = 0; i < CYCLES; i += 1) {
    await app.press("id:mobile-nav-contacts");
    // While it loads: the loading blocks, or the rows of the last load; then the rows or the error.
    await app.waitUntil(() => app.shows("id:contact-row:tg:1000") || app.shows("id:contacts-error"));
    expect(location(app)).toBe("/e/default/contacts");
    await app.press("id:mobile-nav-todo");
    await app.waitUntil(() => app.shows("id:todo-item-task-0") || app.shows("text:agent offline"));
    expect(location(app)).toBe("/e/default/todo");
  }
  expect(contactLoads).toBeGreaterThanOrEqual(CYCLES);
  // Contacts still takes presses after the last round trip (a failed load keeps the rows it had).
  await toContacts(app, "id:contact-row:tg:1000");
  await app.press("id:contact-row:tg:1000");
  await app.waitFor("id:contact-detail");
}, TIMEOUT);
