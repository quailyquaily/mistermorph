// The composer's suggestion popup shows only with something in it (FT198): the `/` commands or `$`
// skills its token matches, or the skills' loading or load error. A token nothing matches (an
// absolute path, `/zzzz`, `$nomatch`) shows nothing, and every key is then the field's and the
// page's: Enter sends where it sends and is a new line where it is one, Tab, Up and Down are the
// field's (or the sent messages'), and Escape is the page's. The token is still followed, so matches
// come back as it changes or as the agent's lists arrive, from the first candidate.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { buildComposerSuggestionItems, composerTriggerContext } from "../lib/core/chat-composer-suggestions.js";
import { openConsole, type ApiHandler, type ApiRequest, type ConsoleOptions } from "./harness";

const T0 = Date.parse("2026-11-28T09:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const TOPICS = {
  body: {
    items: [
      { id: "topic-1", title: "Ops", created_at: at(0), updated_at: at(10) },
      { id: "topic-2", title: "Notes", created_at: at(0), updated_at: at(5) },
    ],
  },
};
const CHAT = "/e/default/chat/topic-1";
const COMMANDS = {
  body: {
    items: [
      { value: "/help", title: "/help", description: "Show help" },
      { value: "/hello", title: "/hello", description: "Say hi" },
      { value: "/compact", title: "/compact", description: "Compact the context" },
    ],
  },
};
const SKILLS = {
  body: {
    skills: {
      loaded: [{ id: "deploy", description: "Ship the build" }],
      available: [{ id: "review", description: "Read a diff" }],
    },
  },
};
const PATHS = ["/Users/me/project", "/home/x/y", "/zzzz"];

function sent(id: string, minute: number, task: string) {
  return { id, task, topic_id: "topic-1", status: "done", created_at: at(minute), finished_at: at(minute), result: { final: { output: `Answer ${id}` } } };
}

function chatApi(posts: ApiRequest[], extra: Record<string, ApiHandler> = {}, tasks: unknown[] = []): Record<string, ApiHandler> {
  return {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? tasks : [] } }),
    "GET /proxy:/todo/tasks": { body: { items: [] } },
    "POST /proxy:/tasks": (request: ApiRequest) => {
      posts.push(request);
      return { body: { id: `n${posts.length}`, topic_id: "topic-1", status: "queued" } };
    },
    ...extra,
  };
}

async function openChat(extra: Record<string, ApiHandler> = {}, options: ConsoleOptions = {}, tasks: unknown[] = []) {
  const posts: ApiRequest[] = [];
  const { app, calls } = await openConsole({ location: CHAT, api: chatApi(posts, extra, tasks), ...options });
  await app.waitFor("id:chat-composer-input");
  return { app, calls, posts };
}

/** Lets the app do whatever a key would have made it do. */
const settle = (app: App) => app.wait(300);

/** Nothing of the popup: no shell, no listbox, no title, no "No matches". */
function expectNoPopup(app: App, where: string) {
  const left = {
    popup: app.count("id:chat-composer-suggestions"),
    listbox: app.count("role:listbox"),
    commands: app.count("text:COMMANDS"),
    skills: app.count("text:SKILLS"),
    empty: app.texts().filter((text) => text === "No matches").length,
  };
  expect(`${where}: ${JSON.stringify(left)}`).toBe(`${where}: ${JSON.stringify({ popup: 0, listbox: 0, commands: 0, skills: 0, empty: 0 })}`);
}

const input = (app: App) => app.value("id:chat-composer-input");

/* ---------- commands ---------- */

for (const [name, commands] of [
  ["the agent's commands", COMMANDS],
  ["the built-in commands", { status: 404, body: { error: "no commands here" } }],
] as const) {
  test(`with ${name}, a path or an unmatched command shows no popup and Enter sends it as it is`, async () => {
    for (const path of PATHS) {
      const { app, posts } = await openChat({ "GET /commands": commands });
      // A lone slash lists the commands (the popup is there while there is something to show).
      await app.type("id:chat-composer-input", "/");
      await app.waitFor("id:chat-composer-suggestions");
      expect(app.count("role:listbox")).toBe(1);
      await app.type("id:chat-composer-input", path.slice(1));
      await app.waitUntil(() => input(app) === path);
      await settle(app);
      expectNoPopup(app, path);
      // Enter sends the path, with nothing added or lost.
      await app.keyboard.press("enter");
      await app.waitUntil(() => posts.length === 1);
      expect(posts[0].json.task).toBe(path);
      await app.waitUntil(() => input(app) === "");
    }
  });
}

test("in a browser's phone layout Enter after a path is a new line, as without a popup", async () => {
  const { app, posts } = await openChat({ "GET /commands": COMMANDS }, { width: 390, height: 844 });
  await app.type("id:chat-composer-input", "/home/x/y");
  await settle(app);
  expectNoPopup(app, "phone path");
  await app.keyboard.press("enter");
  await app.keyboard.press("z");
  await app.waitUntil(() => input(app) === "/home/x/y\nz");
  await settle(app);
  expect(posts.length).toBe(0);
  // With a match the popup is there and Enter picks the command, on a phone too.
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "/comp");
  await app.waitFor("id:chat-composer-suggestions");
  await app.keyboard.press("enter");
  await app.waitUntil(() => input(app) === "/compact ");
  expect(posts.length).toBe(0);
});

test("Tab, Up, Down and Escape leave a path alone, and Up and Down still walk the sent messages", async () => {
  // The latest sent message is a path: brought back, it shows no popup, so Up goes on to the one
  // before it and Down comes back to it.
  const tasks = [sent("t2", 2, "/home/x/y"), sent("t1", 1, "Check the logs")];
  const { app, posts } = await openChat({ "GET /commands": COMMANDS }, {}, tasks);
  await app.waitFor("Answer t2");
  await app.type("id:chat-composer-input", "/Users/me/project");
  await settle(app);
  expectNoPopup(app, "typed path");
  for (const key of ["tab", "up", "down", "escape"]) {
    await app.press("id:chat-composer-input");
    await app.keyboard.press(key);
    await settle(app);
    expect(`${key}: ${input(app)}`).toBe(`${key}: /Users/me/project`);
    expectNoPopup(app, `after ${key}`);
  }
  expect(posts.length).toBe(0);

  await app.clear("id:chat-composer-input");
  await app.press("id:chat-composer-input");
  await app.keyboard.press("up");
  await app.waitUntil(() => input(app) === "/home/x/y");
  await settle(app);
  expectNoPopup(app, "path from history");
  await app.keyboard.press("up");
  await app.waitUntil(() => input(app) === "Check the logs");
  await app.keyboard.press("down");
  await app.waitUntil(() => input(app) === "/home/x/y");
  await app.keyboard.press("down");
  await app.waitUntil(() => input(app) === "");
  expect(posts.length).toBe(0);
});

test("a slash, a path and back: the commands come back from the first, and only one kind shows", async () => {
  const { app } = await openChat({ "GET /commands": COMMANDS });
  await app.type("id:chat-composer-input", "/");
  await app.waitFor("id:chat-composer-suggestions");
  // One kind at a time: the commands' title, options for each command, no skills.
  expect(app.shows("text:COMMANDS")).toBe(true);
  expect(app.count("text:SKILLS")).toBe(0);
  expect(app.count("role:listbox[Commands]")).toBe(1);
  expect(app.count("role:option")).toBe(3);
  expect(app.shows("Compact the context")).toBe(true);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.type("id:chat-composer-input", "U");
  await settle(app);
  expectNoPopup(app, "/U");
  await app.keyboard.press("backspace");
  await app.waitFor("id:chat-composer-suggestions");
  expect(input(app)).toBe("/");
  // The first command is chosen again, not the third chosen before.
  await app.keyboard.press("enter");
  await app.waitUntil(() => input(app) === "/help ");
});

test("an unmatched letter hides the commands and taking it back shows them from the first", async () => {
  const { app } = await openChat({ "GET /commands": COMMANDS });
  await app.type("id:chat-composer-input", "/hel");
  await app.waitFor("Say hi");
  expect(app.count("role:option")).toBe(2);
  await app.keyboard.press("down");
  await app.type("id:chat-composer-input", "x");
  await settle(app);
  expectNoPopup(app, "/helx");
  await app.keyboard.press("backspace");
  await app.waitFor("Say hi");
  await app.keyboard.press("tab");
  await app.waitUntil(() => input(app) === "/help ");
});

test("commands that arrive after the token show at once, from the first, never a candidate chosen before", async () => {
  const late = {
    delay: 1500,
    body: {
      items: [
        { value: "/qxalpha", title: "/qxalpha", description: "Late first" },
        { value: "/qxbeta", title: "/qxbeta", description: "Late second" },
      ],
    },
  };
  // Typed before the agent's commands arrive: the built-in ones match nothing, so nothing shows.
  {
    const { app } = await openChat({ "GET /commands": late });
    await app.type("id:chat-composer-input", "/qx");
    await settle(app);
    expectNoPopup(app, "/qx before the commands");
    await app.waitFor("Late first");
    expect(app.count("role:option")).toBe(2);
    await app.keyboard.press("enter");
    await app.waitUntil(() => input(app) === "/qxalpha ");
  }
  // A lone slash lists the built-in commands meanwhile; the one chosen there is not kept when the
  // agent's list replaces them.
  {
    const { app } = await openChat({ "GET /commands": late });
    await app.type("id:chat-composer-input", "/");
    await app.waitFor("id:chat-composer-suggestions");
    expect(app.shows("text:/help")).toBe(true);
    await app.keyboard.press("down");
    await app.keyboard.press("down");
    await app.waitFor("Late second");
    expect(input(app)).toBe("/");
    await app.keyboard.press("enter");
    await app.waitUntil(() => input(app) === "/qxalpha ");
  }
});

// Headless `nsh test` moves no caret with the arrow keys (the text goes on at the end) and ignores
// setSelection, so a caret moved inside the text is checked on what the composer runs for it
// (onSelectionChange: the token before the caret, then its candidates).
test("a caret moved into a command token in the middle of the text finds it, and one after a path finds nothing", () => {
  const text = "run /comp now /home/x";
  const at = (caret: number) => {
    const context = composerTriggerContext(text, caret);
    return { context, items: (buildComposerSuggestionItems as (options: unknown) => any[])({ context }) };
  };
  // After the path: a command token nothing matches (the popup hides).
  expect(at(text.length).context).toMatchObject({ type: "command", query: "home/x", start: 14, end: text.length });
  expect(at(text.length).items.length).toBe(0);
  // Inside "now": no token at all.
  expect(at(12).context).toBeNull();
  // At the end of "/comp": the built-in command it matches.
  expect(at(9).context).toMatchObject({ type: "command", query: "comp", start: 4, end: 9 });
  expect(at(9).items.map((item) => item.value)).toEqual(["/ctx compact"]);
  // Inside the path: "/home" matches nothing either. (Its first letters, "/ho", still match
  // descriptions, "show", by the matching rules, which did not change.)
  expect(at(19).context).toMatchObject({ type: "command", query: "home", start: 14, end: 19 });
  expect(at(19).items.length).toBe(0);
  expect(at(17).items.length).toBeGreaterThan(0);
});

test("another topic or a send under way closes a shown popup, and a hidden one stays hidden", async () => {
  const { app, posts } = await openChat({ "GET /commands": COMMANDS });
  await app.type("id:chat-composer-input", "/home/x");
  await settle(app);
  expectNoPopup(app, "path in topic 1");
  await app.press("id:chat-topic-topic-2");
  await app.waitUntil(() => input(app) === "");
  expectNoPopup(app, "topic 2");
  // A popup shown in one topic does not follow to another topic's draft (it was for "/" there).
  await app.type("id:chat-composer-input", "/");
  await app.waitFor("id:chat-composer-suggestions");
  await app.press("id:chat-topic-topic-1");
  await app.waitUntil(() => input(app) === "/home/x");
  await settle(app);
  expectNoPopup(app, "back in topic 1");
  // Typing on finds the token again.
  await app.press("id:chat-composer-input");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => input(app) === "/home/");
  await settle(app);
  expectNoPopup(app, "/home/");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "/hel");
  await app.waitFor("id:chat-composer-suggestions");
  // Sending turns the composer read-only and clears it: the popup goes.
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].json.task).toBe("/hel");
  await app.waitUntil(() => input(app) === "");
  expectNoPopup(app, "sent");
});

/* ---------- skills ---------- */

test("loaded skills: `$` lists them, `$nomatch` shows nothing and Enter sends it", async () => {
  const { app, posts } = await openChat({ "GET /settings/agent": SKILLS });
  await app.type("id:chat-composer-input", "$");
  await app.waitFor("text:$deploy");
  expect(app.shows("text:SKILLS")).toBe(true);
  expect(app.count("text:COMMANDS")).toBe(0);
  expect(app.count("role:listbox[Skills]")).toBe(1);
  expect(app.count("role:option")).toBe(2);
  expect(app.count("id:chat-composer-suggestions-feedback")).toBe(0);
  await app.type("id:chat-composer-input", "nomatch");
  await settle(app);
  expectNoPopup(app, "$nomatch");
  await app.keyboard.press("enter");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].json.task).toBe("$nomatch");
});

test("skills still loading say so, with no empty listbox, then their matches take the place", async () => {
  const { app } = await openChat({ "GET /settings/agent": { ...SKILLS, delay: 1500 } });
  await app.type("id:chat-composer-input", "$rev");
  await app.waitFor("id:chat-composer-suggestions-feedback");
  expect(app.shows("Loading skills...")).toBe(true);
  expect(app.shows("text:SKILLS")).toBe(true);
  expect(app.count("role:listbox")).toBe(0);
  expect(app.count("role:option")).toBe(0);
  await app.waitFor("text:$review");
  expect(app.count("id:chat-composer-suggestions-feedback")).toBe(0);
  expect(app.count("role:listbox[Skills]")).toBe(1);
  expect(app.count("role:option")).toBe(1);
  await app.keyboard.press("enter");
  await app.waitUntil(() => input(app) === "$review ");
});

test("skills still loading and then none matching: the loading text goes and nothing takes its place", async () => {
  const { app } = await openChat({ "GET /settings/agent": { ...SKILLS, delay: 1500 } });
  await app.type("id:chat-composer-input", "$nomatch");
  await app.waitFor("Loading skills...");
  await app.waitFor("id:chat-composer-suggestions", { state: "gone" });
  expectNoPopup(app, "$nomatch after the load");
});

test("skills that fail to load say why, with no empty listbox", async () => {
  const { app } = await openChat({ "GET /settings/agent": { status: 500, body: { error: "skills are down" } } });
  await app.type("id:chat-composer-input", "$");
  await app.waitFor("id:chat-composer-suggestions-feedback");
  await app.waitUntil(() => app.texts().some((text) => text.includes("skills are down")));
  expect(app.shows("text:SKILLS")).toBe(true);
  expect(app.count("role:listbox")).toBe(0);
  // The feedback is the popup's: Escape closes it.
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-composer-suggestions", { state: "gone" });
  expect(input(app)).toBe("$");
});

/* ---------- the Todo composer, which has no skills ---------- */

test("in the Todo composer `$x` shows nothing and Enter writes the job", async () => {
  const posts: ApiRequest[] = [];
  const { app } = await openConsole({
    location: "/e/default/todo",
    api: {
      ...chatApi([]),
      "POST /proxy:/todo/tasks": (request: ApiRequest) => {
        posts.push(request);
        return { status: 500, body: { error: "not now" } };
      },
      "POST /proxy:/tasks": (request: ApiRequest) => {
        posts.push(request);
        return { status: 500, body: { error: "not now" } };
      },
      "POST /proxy:/topics": (request: ApiRequest) => {
        posts.push(request);
        return { status: 500, body: { error: "not now" } };
      },
    },
  });
  await app.waitFor("id:todo-compose");
  await app.type("id:todo-compose >> id:chat-composer-input", "$x");
  await settle(app);
  expectNoPopup(app, "todo $x");
  await app.keyboard.press("enter");
  await app.waitUntil(() => posts.length > 0);
  expect(JSON.stringify(posts[0].json)).toContain("$x");
});
