// Chat: a conversation or topic list that fails to load (the network, the agent restarting) says so
// in the view, centred, with a Refresh; a Refresh that works shows the conversation, one that fails
// again leaves the Refresh usable; messages already on screen stay through a failed reload; a send
// that fails is not a load failure.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const CHAT = "/e/default/chat";
const NOW = new Date().toISOString();

function topic(id: string, title: string) {
  return { id, title, created_at: NOW, updated_at: NOW };
}

function doneTask(id: string, task: string, output: string, topicID = "topic-1") {
  return { id, task, topic_id: topicID, status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output } } };
}

const TOPICS = [topic("topic-1", "Ops"), topic("topic-2", "Recipes")];
const DOWN = (error: string) => ({ status: 503, body: { error } });

function historyRequests(calls: ApiRequest[], topicID = "topic-1") {
  return calls.filter((call) => call.method === "GET" && call.uri?.startsWith("/tasks?") && call.uri.includes(`topic_id=${topicID}`)).length;
}

function topicListRequests(calls: ApiRequest[]) {
  return calls.filter((call) => call.method === "GET" && call.uri?.startsWith("/topics?")).length;
}

test("a conversation that fails to load shows a centred error with a Refresh, and a Refresh that works shows the conversation", async () => {
  let fail = true;
  const { app, calls } = await openConsole({
    location: `${CHAT}/topic-1`,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": () => (fail ? DOWN("runtime is restarting") : { body: { items: [doneTask("task-1", "Hello", "Hi there")] } }),
    },
  });
  await app.waitFor("id:chat-load-error");
  await app.waitFor("text:Couldn't load this conversation");
  await app.waitFor("text:runtime is restarting");
  // Not a blank view, nor a load that never ends: the error stands in for the list.
  expect(app.shows("id:chat-history-skeleton")).toBe(false);
  expect(app.shows("id:chat-history")).toBe(false);
  expect(app.enabled("id:chat-load-error-refresh")).toBe(true);
  // Said once, in the view (not in the notice stack as well).
  expect(app.count("text:runtime is restarting")).toBe(1);
  // The composer stays.
  expect(app.shows("id:chat-composer-input")).toBe(true);

  fail = false;
  const history = historyRequests(calls);
  const topicLists = topicListRequests(calls);
  await app.press("id:chat-load-error-refresh");
  await app.waitFor("text:Hi there");
  await app.waitFor("id:chat-load-error", { state: "gone" });
  expect(app.shows("id:chat-load-error-strip")).toBe(false);
  // One press, one load of this conversation; the topic list loaded fine, so it is not asked again.
  expect(historyRequests(calls) - history).toBe(1);
  expect(topicListRequests(calls) - topicLists).toBe(0);
});

test("a Refresh that fails again keeps the error and the Refresh, and an empty conversation is told apart from a failed one", async () => {
  let attempt = 0;
  let fail = true;
  const { app, calls } = await openConsole({
    location: `${CHAT}/topic-1`,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": () => {
        attempt += 1;
        return fail ? DOWN(`network down (${attempt})`) : { body: { items: [] } };
      },
    },
  });
  await app.waitFor("text:network down (1)");
  await app.press("id:chat-load-error-refresh");
  await app.waitFor("text:network down (2)");
  expect(app.shows("id:chat-load-error")).toBe(true);
  expect(app.enabled("id:chat-load-error-refresh")).toBe(true);
  await app.press("id:chat-load-error-refresh");
  await app.waitFor("text:network down (3)");
  expect(app.enabled("id:chat-load-error-refresh")).toBe(true);
  expect(historyRequests(calls)).toBe(3);

  fail = false;
  await app.press("id:chat-load-error-refresh");
  await app.waitFor("text:No tasks in this topic yet.");
  await app.waitFor("id:chat-load-error", { state: "gone" });
  expect(app.shows("text:/network down/")).toBe(false);
});

test("a topic list that fails to load shows the error in place of the landing, and a Refresh loads the topics", async () => {
  let fail = true;
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": () => (fail ? DOWN("topics unavailable") : { body: { items: TOPICS } }),
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await app.waitFor("id:chat-load-error");
  await app.waitFor("text:Couldn't load your conversations");
  await app.waitFor("text:topics unavailable");
  expect(app.shows("id:chat-placeholder")).toBe(false);

  await app.press("id:chat-load-error-refresh");
  await app.waitFor("text:topics unavailable");
  expect(app.shows("id:chat-load-error")).toBe(true);

  fail = false;
  await app.press("id:chat-load-error-refresh");
  await app.waitFor("id:chat-topic-topic-1");
  await app.waitFor("id:chat-load-error", { state: "gone" });
  expect(app.shows("text:topics unavailable")).toBe(false);
});

test("on an Android phone a failed first load shows the error with its Refresh, which brings the topic list", async () => {
  let fail = true;
  const { app } = await openConsole({
    platform: "android",
    location: CHAT,
    api: {
      "GET /proxy:/topics": () => (fail ? DOWN("no network") : { body: { items: TOPICS } }),
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await app.waitFor("id:chat-load-error");
  await app.waitFor("text:no network");
  fail = false;
  await app.press("id:chat-load-error-refresh");
  await app.waitFor("id:chat-topic-topic-2");
  expect(app.shows("id:chat-load-error")).toBe(false);
});

test("a reload that fails keeps the messages already on screen and offers a Refresh beside them", async () => {
  let topicsFail = true;
  let historyFail = false;
  const { app } = await openConsole({
    location: `${CHAT}/topic-1`,
    api: {
      "GET /proxy:/topics": () => (topicsFail ? DOWN("topics unavailable") : { body: { items: TOPICS } }),
      "GET /proxy:/tasks": () => (historyFail ? DOWN("history store down") : { body: { items: [doneTask("task-1", "Hello", "Hi there")] } }),
    },
  });
  // The conversation loaded and the topic list did not: the messages, and a strip for the list.
  await app.waitFor("text:Hi there");
  await app.waitFor("id:chat-load-error-strip");
  await app.waitFor("text:/Couldn't load your conversations/");
  expect(app.shows("id:chat-load-error")).toBe(false);

  // The Refresh reloads both; both fail now, and the messages stay.
  historyFail = true;
  await app.press("id:chat-load-error-strip-refresh");
  await app.waitFor("text:/history store down/");
  expect(app.shows("text:Hi there")).toBe(true);
  expect(app.shows("id:chat-load-error")).toBe(false);
  expect(app.enabled("id:chat-load-error-strip-refresh")).toBe(true);

  topicsFail = false;
  historyFail = false;
  await app.press("id:chat-load-error-strip-refresh");
  await app.waitFor("id:chat-topic-topic-2");
  await app.waitFor("id:chat-load-error-strip", { state: "gone" });
  expect(app.shows("text:Hi there")).toBe(true);
});

test("a failed conversation's error stays with it: another topic opens as usual, and coming back loads it again", async () => {
  let topic1Fails = true;
  const { app } = await openConsole({
    location: `${CHAT}/topic-1`,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": (request: ApiRequest) => {
        if (request.uri?.includes("topic_id=topic-2")) return { body: { items: [doneTask("task-2", "Soup?", "Tomato soup", "topic-2")] } };
        return topic1Fails ? DOWN("history store down") : { body: { items: [doneTask("task-1", "Hello", "Hi there")] } };
      },
    },
  });
  await app.waitFor("id:chat-load-error");
  await app.press("id:chat-topic-topic-2");
  await app.waitFor("text:Tomato soup");
  expect(app.shows("id:chat-load-error")).toBe(false);
  expect(app.shows("id:chat-load-error-strip")).toBe(false);

  // Back to the failed one: it loads again (and fails again: the error is back).
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-load-error");
  expect(app.shows("text:Tomato soup")).toBe(false);

  topic1Fails = false;
  await app.press("id:chat-topic-topic-2");
  await app.waitFor("text:Tomato soup");
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:Hi there");
  expect(app.shows("id:chat-load-error")).toBe(false);
});

test("a send that fails keeps the conversation and is not shown as a load failure", async () => {
  const { app } = await openConsole({
    location: `${CHAT}/topic-1`,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": { body: { items: [doneTask("task-1", "Hello", "Hi there")] } },
      "POST /proxy:/tasks": { status: 500, body: { error: "queue full" } },
    },
  });
  await app.waitFor("text:Hi there");
  await app.type("id:chat-composer-input", "One more thing");
  await app.press("id:chat-composer-send");
  await app.waitFor("text:queue full");
  expect(app.shows("text:Hi there")).toBe(true);
  expect(app.shows("id:chat-history")).toBe(true);
  expect(app.shows("id:chat-load-error")).toBe(false);
  expect(app.shows("id:chat-load-error-strip")).toBe(false);
});

test("on a phone a topic list that fails to refresh keeps its topics and says so at their top", async () => {
  let topicsFail = false;
  const { app } = await openConsole({
    platform: "android",
    location: CHAT,
    api: {
      "GET /proxy:/topics": () => (topicsFail ? DOWN("topics unavailable") : { body: { items: TOPICS } }),
      "GET /proxy:/tasks": (request: ApiRequest) =>
        request.uri?.startsWith("/tasks/") ? { body: doneTask("task-2", "One more thing", "Done") } : { body: { items: [doneTask("task-1", "Hello", "Hi there")] } },
      "POST /proxy:/tasks": { body: { id: "task-2", status: "queued", topic_id: "topic-1" } },
    },
  });
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:Hi there");
  // The send works; the topic list's reload after it does not.
  topicsFail = true;
  await app.type("id:chat-composer-input", "One more thing");
  await app.press("id:chat-composer-send");
  await app.waitFor("id:chat-load-error-strip");
  expect(app.shows("text:Hi there")).toBe(true);
  expect(app.shows("id:chat-load-error")).toBe(false);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topics-load-error");
  expect(app.shows("id:chat-topic-topic-2")).toBe(true);
  topicsFail = false;
  await app.press("id:chat-topics-load-error-refresh");
  await app.waitFor("id:chat-topics-load-error", { state: "gone" });
  expect(app.shows("id:chat-topic-topic-2")).toBe(true);
});
