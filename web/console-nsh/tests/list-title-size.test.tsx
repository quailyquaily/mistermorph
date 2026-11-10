// The titles of the second column's list rows (Topics, Contacts, Memories, Skills, TODO) are 15pt
// on mobile and 14pt on a desktop; their meta lines and group labels keep their smaller sizes, and
// a long title stays cut (one fading line for a topic, two lines for an index row) with no row
// growing past its column or shrinking below its touch target.
import { expect, open, test } from "nsh/test";
import { openConsole } from "./harness";

type Frame = { x: number; y: number; w: number; h: number };

const NOW = new Date().toISOString();
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, title: 14 },
  { name: "phone", width: 390, height: 844, title: 15 },
] as const;

const CRON_ID = "_cron_digest";
const TOPICS = [
  { id: "topic-1", title: "Trip plans", created_at: NOW, updated_at: NOW },
  { id: CRON_ID, title: "Daily digest", llm_model: "gpt-5.2", created_at: NOW, updated_at: NOW },
];
const ALICE = { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", tg_username: "alice", status: "active" };
const SKILLS = {
  enabled: true,
  load: [],
  roots: ["/skills"],
  config_revision: "rev-1",
  skills: [{ id: "weather", name: "Weather", description: "Forecasts", dir: "/skills/weather", loaded: true, files: [{ path: "SKILL.md", size: 10 }] }],
};
const TODO = {
  tasks: [{ id: "task-1", title: "Review", content: "Look", cron: "15 9 * * 1", tz: "UTC" }],
  system_tasks: [{ id: "__heartbeat__", cron: "*/30 * * * *" }],
  chat_options: [],
  llm_profiles: [],
  heartbeat_enabled: true,
  runs: [],
};

for (const viewport of VIEWPORTS) {
  const size = { width: viewport.width, height: viewport.height };

  test(`Topics on a ${viewport.name}: a ${viewport.title}pt title, 11pt group labels`, async () => {
    const { app } = await openConsole({
      location: "/e/default/chat",
      ...size,
      api: {
        "GET /proxy:/topics": { body: { items: TOPICS } },
        "GET /proxy:/tasks": { body: { items: [] } },
        "GET /proxy:/todo/tasks": { body: { tasks: [] } },
      },
    });
    await app.waitFor("id:chat-topic-topic-1");
    expect(app.spanStyle("id:chat-topic-topic-1 >> text:Trip plans").fontSize).toBe(viewport.title);
    expect(app.spanStyle("text:TODAY").fontSize).toBe(11);
    // A TODO run's topic: its model line under the title stays 12pt mono.
    await app.press("id:chat-topics-view-cron");
    await app.waitFor(`id:chat-topic-${CRON_ID}`);
    expect(app.spanStyle(`id:chat-topic-${CRON_ID} >> text:Daily digest`).fontSize).toBe(viewport.title);
    await app.waitFor(`id:chat-topic-${CRON_ID} >> text:gpt-5.2`);
    expect(app.spanStyle(`id:chat-topic-${CRON_ID} >> text:gpt-5.2`).fontSize).toBe(12);
  });

  test(`Contacts on a ${viewport.name}: a ${viewport.title}pt name over a 12pt meta`, async () => {
    const { app } = await openConsole({ location: "/e/default/contacts", ...size, api: { "GET /proxy:/contacts/list": { body: { items: [ALICE] } } } });
    await app.waitFor("id:contact-row:tg:1001");
    expect(app.spanStyle("id:contact-row:tg:1001 >> text:Alice").fontSize).toBe(viewport.title);
    expect(app.spanStyle("id:contact-row:tg:1001 >> text:Telegram · @alice").fontSize).toBe(12);
  });

  test(`Memories, Skills and TODO on a ${viewport.name}: ${viewport.title}pt titles over 12pt metas`, async () => {
    const memories = await openConsole({ location: "/e/default/memories", ...size, api: { "GET /proxy:/memories": { body: { items: [] } } } });
    await memories.app.waitFor("id:memories-journal");
    expect(memories.app.spanStyle("id:memories-journal >> text:Journal").fontSize).toBe(viewport.title);
    expect(memories.app.spanStyle("id:memories-journal >> text:What the agent heard, day by day").fontSize).toBe(12);

    const skills = await openConsole({
      location: "/e/default/skills",
      ...size,
      api: {
        "GET /settings/agent/skills/store": { status: 404, body: { error: "not found" } },
        "GET /settings/agent/skills": { body: SKILLS },
        "GET /settings/agent/skills/detail": { body: { content: "# Weather\n", revision: "doc-1" } },
      },
    });
    await skills.app.waitFor("id:skill-row:weather");
    expect(skills.app.spanStyle("id:skill-row:weather >> text:Weather").fontSize).toBe(viewport.title);
    expect(skills.app.spanStyle("id:skill-row:weather >> text:Forecasts").fontSize).toBe(12);

    const todo = await openConsole({
      location: "/e/default/todo",
      ...size,
      api: {
        "GET /proxy:/todo/tasks": { body: TODO },
        "GET /proxy:/todo/runs": { body: { runs: [] } },
        "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
      },
    });
    await todo.app.waitFor("id:todo-item-task-1");
    expect(todo.app.spanStyle("id:todo-item-task-1 >> text:Review").fontSize).toBe(viewport.title);
    expect(todo.app.spanStyle("id:todo-heartbeat-item >> text:Heartbeat").fontSize).toBe(viewport.title);
  });

  test(`an empty list's note on a ${viewport.name} keeps its size`, async () => {
    const { app } = await openConsole({ location: "/e/default/contacts", ...size });
    await app.waitFor("text:No contacts");
    expect(app.spanStyle("text:No contacts").fontSize).toBe(12);
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800, column: 310, target: 40 },
  { name: "phone", width: 390, height: 844, column: 390, target: 44 },
  { name: "narrow phone", width: 320, height: 640, column: 320, target: 44 },
] as const) {
  test(`on a ${viewport.name} long titles stay cut inside their rows`, async () => {
    const app = await open("./fixtures/list-title-app.tsx", { width: viewport.width, height: viewport.height, platform: "linux", locale: "en-US" });
    const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
    await app.waitUntil(() => Boolean(frames()["plain-long"] && frames()["topic-long"]));
    const f = frames();
    expect(Math.abs(f.column.w - viewport.column)).toBeLessThan(0.5);
    for (const name of ["meta-short", "meta-long", "plain-short", "plain-long", "topic-short-row", "topic-long-row"]) {
      expect(f[name].w).toBeLessThanOrEqual(f.column.w + 0.5);
    }
    // A short title without a meta: the row is no lower than its touch target.
    expect(f["plain-short"].h).toBeGreaterThanOrEqual(viewport.target - 0.5);
    // A long index title wraps to its second line and stops there: one line more than a short one.
    for (const kind of ["meta", "plain"]) {
      const extra = f[`${kind}-long`].h - f[`${kind}-short`].h;
      expect(extra).toBeGreaterThan(10);
      expect(extra).toBeLessThan(24);
    }
    // A topic's title is one line however long, cut inside its row.
    expect(Math.abs(f["topic-long"].h - f["topic-short"].h)).toBeLessThan(0.5);
    expect(f["topic-long"].w).toBeLessThanOrEqual(f["topic-long-row"].w + 0.5);
  });
}
