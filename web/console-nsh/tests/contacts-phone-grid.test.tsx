// The Contacts library on phones: at least three cards a row at 320, 360, 390 and 430pt, the cards
// compact (ContactCard.tsx) and nothing past the page's or a card's edges, with long names, missing
// names and avatars, people and agents. The library shows one kind at a time (the head's tabs,
// ContactKindTabs: people first), each kind in the same grid, by contact id while no interaction is
// recorded. Frames come from tests/fixtures/contacts-library-app.tsx (the real page, its
// `onPartLayout`); the last test opens the whole console as the Android app.
import type { App, StubRequest, StubResponse } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { openConsole } from "./harness";

type Frame = { x: number; y: number; w: number; h: number };

const AGENT_INSTANCE = `inst_${"a".repeat(32)}`;
const CONTACTS = [
  { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", tg_username: "alice", avatar_url: "/contacts/avatar?contact_id=tg:1001" },
  { contact_id: `mm:${AGENT_INSTANCE}`, nickname: "Helper", kind: "agent", channel: "console" },
  // No name and no avatar: the handle is the title, "Unnamed User" the handle.
  { contact_id: "slack:T1:U99", kind: "human", channel: "slack", status: "inactive" },
  {
    contact_id: "tg:1004",
    nickname: "Maximilian Alexander von Hohenzollern-Sigmaringen the Third",
    kind: "human",
    channel: "telegram",
    tg_username: "maximilian_alexander_von_hohenzollern",
  },
  { contact_id: "mm:inst_research", nickname: "Research-and-Development-Coordination-Agent-Number-Seventeen", kind: "agent", channel: "console" },
  { contact_id: "discord_user:900000000000000001", nickname: "山田太郎左衛門尉藤原朝臣信長公記編纂委員会", kind: "human", channel: "discord" },
  { contact_id: "tg:1007", nickname: "Bo", kind: "human", channel: "telegram", tg_username: "bo" },
  { contact_id: "tg:1008", nickname: "Cy", kind: "human", channel: "telegram", tg_username: "cy" },
  { contact_id: "tg:1009", nickname: "Dee", kind: "human", channel: "telegram", tg_username: "dee" },
];
/** A tab's cards in the library's order: no interaction is recorded here, so by contact id. */
const idsOfKind = (kind: string) =>
  CONTACTS.filter((contact) => contact.kind === kind)
    .map((contact) => contact.contact_id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** The people: the tab the page opens on. */
const IDS = idsOfKind("human");
/** The agents: the other tab. */
const AGENT_IDS = idsOfKind("agent");
const TELEGRAM_IDS = IDS.filter((id) => id.startsWith("tg:"));
const PARTS = ["avatar", "name", "kind", "foot", "handle"];
const GUTTER = 12;

async function openLibrary(width: number, options: { items?: unknown[]; listDelay?: number } = {}) {
  const app = await open("./fixtures/contacts-library-app.tsx", {
    width,
    height: 844,
    platform: "linux",
    locale: "en-US",
    reducedMotion: true,
    host: {
      handlers: {
        "morph.boot": {
          runtime: "web",
          origin: "http://console.test",
          basePath: "/",
          location: "/",
          kv: { "quail-language": "en" },
          session: {},
          languages: ["en-US"],
          desktopVersion: "",
          features: [],
        },
        "morph.kv.set": null,
        "morph.fixture.event": null,
      },
    },
    network: Object.fromEntries(["GET", "POST"].map((method) => [`${method} *`, answer])),
  });
  /** The last frame each part reported. */
  const frames = () => {
    const out: Record<string, Frame> = {};
    for (const post of app.host.posts()) {
      if (post.name !== "morph.fixture.event") continue;
      const event = post.data as { name: string; frame: Frame };
      out[event.name] = event.frame;
    }
    return out;
  };
  return { app, frames };

  async function answer(raw: StubRequest): Promise<StubResponse> {
    const url = new URL(raw.url);
    const path = url.pathname.replace(/^\/api/, "");
    const uri = (url.searchParams.get("uri") || "").split("?")[0];
    if (path === "/endpoints") {
      return { body: { items: [{ endpoint_ref: "ep_console_local", name: "Console", url: "in-process://console-local", connected: true, mode: "console" }] } };
    }
    if (path === "/proxy" && uri === "/contacts/list") {
      if (options.listDelay) await new Promise((done) => setTimeout(done, options.listDelay));
      return { body: { items: options.items ?? CONTACTS } };
    }
    if (path === "/proxy" && uri === "/memories") return { body: { items: [] } };
    return { status: 404, body: { error: `no stub for ${path} ${uri}` } };
  }
}

const say = (what: string, value: unknown) => `${what}: ${JSON.stringify(value)}`;
function check(ok: boolean, what: string, value: unknown) {
  const at = say(what, value);
  expect({ at, ok }).toEqual({ at, ok: true });
}
function expectInside(inner: Frame, outer: Frame, what: string) {
  const ok =
    inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
  check(ok, `${what} inside`, { inner, outer });
}

async function measured(app: App, frames: () => Record<string, Frame>, ids = IDS) {
  await app.waitUntil(() => ids.every((id) => frames()[`card:${id}`] && PARTS.every((part) => frames()[`${part}:${id}`])));
  // Let the last layout pass report.
  await app.wait(100);
  return frames();
}

/** The cards `ids` as a grid of `columns` in a page `width` wide: equal widths, in the page's
 *  gutters, apart, each holding its parts one under another. Returns the first card. */
function expectGrid(all: Record<string, Frame>, ids: string[], width: number, columns: number, look: { height: number; avatar: number }) {
  const cards = ids.map((id) => all[`card:${id}`]);
  const first = cards[0];
  check(Math.abs(first.x - GUTTER) <= 0.5, "the first card at the gutter", first);
  cards.forEach((card, index) => {
    const id = ids[index];
    check(Math.abs(card.w - first.w) <= 0.5 && card.h === look.height, `card ${id} the size of the first`, { card, first });
    expectInside(card, { x: GUTTER, y: 0, w: width - 2 * GUTTER, h: 1e6 }, `card ${id} in the page's gutters`);
    const before = cards[index - 1];
    if (index % columns === 0) {
      check(Math.abs(card.x - first.x) <= 0.5, `card ${id} starts a row`, card);
      if (before) check(card.y >= before.y + before.h + 7.5, `card ${id} under the row before`, { card, before });
    } else {
      check(Math.abs(card.y - before.y) <= 0.5 && card.x >= before.x + before.w + 7.5, `card ${id} beside the one before`, { card, before });
    }
    // Its parts: inside it, clear of its border and of each other.
    const [avatar, name, kind, foot, handle] = PARTS.map((part) => all[`${part}:${id}`]);
    const inner = { x: card.x + 1, y: card.y + 1, w: card.w - 2, h: card.h - 2 };
    for (const [part, frame] of [["avatar", avatar], ["name", name], ["kind", kind], ["foot", foot], ["handle", handle]] as const) {
      expectInside(frame, inner, `${part} of ${id}`);
    }
    check(avatar.w === look.avatar && avatar.h === look.avatar, `avatar of ${id}`, avatar);
    check(name.h > 0 && name.w > 0 && kind.w > 0 && handle.w > 0, `texts of ${id} have room`, { name, kind, handle });
    check(avatar.y + avatar.h <= name.y && name.y + name.h <= kind.y && kind.y + kind.h <= foot.y, `parts of ${id} one under another`, { avatar, name, kind, foot });
    expectInside(handle, foot, `handle of ${id} in the foot`);
  });
  // The row fills the page: the last column ends at the right gutter.
  const last = cards[Math.min(columns, cards.length) - 1];
  if (cards.length >= columns) check(Math.abs(last.x + last.w - (width - GUTTER)) <= 0.5, "the row ends at the right gutter", last);
  return first;
}

const COMPACT = { height: 142, avatar: 44 };
const REGULAR = { height: 196, avatar: 64 };

for (const width of [320, 360, 390, 430]) {
  test(`at ${width}pt the library shows three compact cards a row, each holding its parts`, async () => {
    const { app, frames } = await openLibrary(width);
    await app.waitFor("id:contact-row:tg:1007");
    const all = await measured(app, frames);
    check(all.library.x === 0 && all.library.w === width, "the library takes the page's width", all.library);
    const first = expectGrid(all, IDS, width, 3, COMPACT);
    check(first.w >= 90, "a card's width", first);
    // What a card says stays: the name, the kind and the handle, and for screen readers all of it.
    expect(app.shows("id:contact-row:tg:1004 >> text:Maximilian Alexander von Hohenzollern-Sigmaringen the Third")).toBe(true);
    expect(app.shows("id:contact-row:tg:1004 >> text:HUMAN")).toBe(true);
    expect(app.shows("id:contact-row:tg:1004 >> text:@maximilia…zollern")).toBe(true);
    expect(app.shows("id:contact-row:slack:T1:U99 >> text:U99")).toBe(true);
    expect(app.shows("id:contact-row:slack:T1:U99 >> text:Unnamed User")).toBe(true);

    // A card opens its contact; back shows the library again, laid out the same.
    await app.press("id:contact-row:tg:1004");
    await app.waitFor("id:contact-detail");
    await app.waitFor("id:contacts-index", { state: "gone" });
    await app.press("id:mobile-back");
    await app.waitFor("id:contact-row:tg:1004");
    await app.waitFor("id:contact-detail", { state: "gone" });
    expectGrid(await measured(app, frames), IDS, width, 3, COMPACT);

    // The Agents tab: the same compact grid, from the first column.
    await app.press("id:contacts-tab-agent");
    await app.waitFor("id:contact-row:mm:inst_research");
    await app.waitFor("id:contact-row:tg:1007", { state: "gone" });
    const agents = expectGrid(await measured(app, frames, AGENT_IDS), AGENT_IDS, width, 3, COMPACT);
    check(Math.abs(agents.w - first.w) <= 0.5, "an agent's card the width of a person's", { agents, first });
    expect(app.shows("id:contact-row:mm:inst_research >> text:AGENT")).toBe(true);
  });
}

test("a filter keeps the compact grid; the cards it leaves close ranks from the first column", async () => {
  const { app, frames } = await openLibrary(390);
  await app.waitFor("id:contact-row:tg:1007");
  const before = (await measured(app, frames))["card:tg:1001"];
  // Among the people, tg:1001 stands in the third column until the filter leaves Telegram's only.
  check(before.x > GUTTER + before.w, "tg:1001 past the first column", before);
  await app.type("id:contacts-filter", "telegram");
  await app.waitFor("id:contact-row:slack:T1:U99", { state: "gone" });
  await app.waitFor("id:contact-row:discord_user:900000000000000001", { state: "gone" });
  await app.waitUntil(() => Math.abs(frames()[`card:${TELEGRAM_IDS[0]}`].x - GUTTER) <= 0.5);
  const first = expectGrid(await measured(app, frames, TELEGRAM_IDS), TELEGRAM_IDS, 390, 3, COMPACT);
  check(Math.abs(first.w - before.w) <= 0.5, "the cards keep their width", { first, before });
  await app.clear("id:contacts-filter");
  await app.waitFor("id:contact-row:slack:T1:U99");
  await app.waitUntil(() => Math.abs(frames()["card:tg:1001"].x - before.x) <= 0.5);
  expectGrid(await measured(app, frames), IDS, 390, 3, COMPACT);
});

test("resizing between a phone and a desktop swaps the compact cards and the desktop's", async () => {
  const { app, frames } = await openLibrary(390);
  await app.waitFor("id:contact-row:tg:1007");
  expectGrid(await measured(app, frames), IDS, 390, 3, COMPACT);

  await app.setViewport(1280, 800);
  await app.waitUntil(() => frames()["card:tg:1001"].h === REGULAR.height && frames()["avatar:tg:1001"].w === REGULAR.avatar);
  let all = await measured(app, frames);
  // The desktop's grid as before: 16pt at the sides, 14pt gaps, cards at least 188pt wide.
  const row = IDS.map((id) => all[`card:${id}`]);
  check(row[0].x === 16 && row[0].w >= 188 && Math.abs(row[1].x - (row[0].x + row[0].w) - 14) <= 0.5, "the desktop's cards", row.slice(0, 2));
  check(row.slice(0, 6).every((card) => card.y === row[0].y) && row[6].y > row[0].y, "six a row", row);

  await app.setViewport(320, 700);
  await app.waitUntil(() => frames()["card:tg:1001"].h === COMPACT.height && frames()["avatar:tg:1001"].w === COMPACT.avatar);
  all = await measured(app, frames);
  expectGrid(all, IDS, 320, 3, COMPACT);
  // A card still opens its contact.
  await app.press("id:contact-row:tg:1007");
  await app.waitFor("id:contact-detail");
});

test("on a desktop the cards keep their size, and the picked one its highlight", async () => {
  const { app, frames } = await openLibrary(1280);
  await app.waitFor("id:contact-row:tg:1007");
  const all = await measured(app, frames);
  for (const id of IDS) {
    const card = all[`card:${id}`];
    check(card.h === REGULAR.height && card.w >= 188, `card ${id}`, card);
    check(all[`avatar:${id}`].w === REGULAR.avatar && all[`avatar:${id}`].h === REGULAR.avatar, `avatar of ${id}`, all[`avatar:${id}`]);
    expectInside(all[`name:${id}`], card, `name of ${id}`);
    expectInside(all[`foot:${id}`], card, `foot of ${id}`);
  }
  await app.press("id:contact-row:tg:1004");
  await app.waitFor("id:contact-detail");
  expect(app.shows("id:contacts-selection")).toBe(true);
  expect(app.shows("id:contacts-list")).toBe(true);
});

test("wide phones and tablets keep the wider cards, never fewer than three a row", async () => {
  // 620pt: three cards of the phone's width or more; 800pt: four.
  for (const [width, columns] of [[620, 3], [800, 4]] as const) {
    const { app, frames } = await openLibrary(width);
    await app.waitFor("id:contact-row:tg:1007");
    const all = await measured(app, frames);
    const row = IDS.map((id) => all[`card:${id}`]);
    check(row[0].h === REGULAR.height && row[0].w >= 150, `${width}pt: the wider card`, row[0]);
    check(row.slice(0, columns).every((card) => card.y === row[0].y) && row[columns].y > row[0].y, `${width}pt: ${columns} a row`, row);
    check(row[columns - 1].x + row[columns - 1].w <= width + 0.5, `${width}pt: in the page`, row[columns - 1]);
  }
});

test("while the list loads, a phone shows a row of blocks in the cards' columns", async () => {
  const { app, frames } = await openLibrary(360, { listDelay: 400 });
  await app.waitFor("id:contact-row:tg:1007");
  const all = await measured(app, frames);
  for (const [column, id] of IDS.slice(0, 3).entries()) {
    const block = all[`block:${column}`];
    const card = all[`card:${id}`];
    check(Boolean(block), `block ${column} measured`, block ?? null);
    // To a point: headless frames snap to whole points.
    check(Math.abs(block.x - card.x) <= 1 && Math.abs(block.w - card.w) <= 1 && block.h === card.h, `block ${column} where card ${id} comes`, { block, card });
  }
  expect(all["block:3"]).toBe(undefined);
});

test("the Android app's library opens a compact card's contact and comes back", async () => {
  const { app } = await openConsole({
    location: "/e/default/contacts",
    platform: "android",
    width: 320,
    height: 700,
    api: { "GET /proxy:/contacts/list": { body: { items: CONTACTS } }, "GET /proxy:/memories": { body: { items: [] } } },
  });
  await app.waitFor("id:contact-row:tg:1007");
  expect(app.shows("label:Maximilian Alexander von Hohenzollern-Sigmaringen the Third")).toBe(true);
  // The agents are on their own tab.
  await app.press("id:contacts-tab-agent");
  await app.waitFor("id:contact-row:mm:inst_research");
  await app.press("id:contact-row:mm:inst_research");
  await app.waitFor("id:contact-detail");
  await app.waitFor("text:AGENT · CONSOLE");
  await app.press("id:mobile-back");
  await app.waitFor("id:contact-row:mm:inst_research");
});
