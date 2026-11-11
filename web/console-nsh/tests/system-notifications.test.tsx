// System notifications through a host the test plays (lib/core/system-notifications.js and
// topic-task-notifications.js). The desktop app answers the same `morph.notify.*` calls as the
// browser (desktop/nsh/src/notify.rs), so these hold for both: a notification is tried once, never
// without the permission (a desktop with no notification service says "unsupported"), a failed one
// is not tried again, and a pressed topic notification opens its topic.
import { expect, test } from "nsh/test";
import { requestSystemNotificationPermission, showSystemNotification } from "../lib/core/system-notifications.js";
import { handleTopicTaskNotification } from "../lib/core/topic-task-notifications.js";
import type { NotificationPermission } from "../lib/platform";

type Shown = { id: string; title: string; body: string; tag?: string };

/** A host whose answers the test sets, and what was asked of it. */
function fakeHost({
  desktop = true,
  permission = "granted" as NotificationPermission | (() => NotificationPermission),
  show = (_shown: Shown): void => {},
  request = (): NotificationPermission => "granted",
} = {}) {
  const shown: Shown[] = [];
  const asked: string[] = [];
  const pressListeners: ((id: string) => void)[] = [];
  const kv = new Map<string, string>();
  let foreground = false;
  const host = {
    desktop: () => desktop,
    permission: async (): Promise<NotificationPermission> => {
      asked.push("state");
      return typeof permission === "function" ? permission() : permission;
    },
    request: async (): Promise<NotificationPermission> => {
      asked.push("request");
      return request();
    },
    show: async (options: Shown) => {
      shown.push(options);
      show(options);
    },
    onPress: (listener: (id: string) => void) => {
      pressListeners.push(listener);
      return () => {};
    },
    isForeground: () => foreground,
    storage: {
      getItem: (key: string) => kv.get(key) ?? null,
      setItem: (key: string, value: string) => void kv.set(key, String(value)),
      removeItem: (key: string) => void kv.delete(key),
      keys: () => [...kv.keys()],
    },
  };
  return {
    host,
    shown,
    asked,
    kv,
    press: (id: string) => pressListeners.forEach((listener) => listener(id)),
    setForeground: (value: boolean) => {
      foreground = value;
    },
  };
}

const translate = (key: string) => ({ topic_notification_done: "Task finished", topic_notification_failed: "Task failed", chat_topic_untitled: "Untitled" })[key] ?? key;

function topicEvent(overrides: Record<string, unknown> = {}) {
  return { type: "topic_task_completed", id: "task-1", topic_id: "topic-1", status: "done", ...overrides };
}

/* ---------- console notifications ---------- */

test("a console notification goes out once, through the host, with its text cut to size", async () => {
  const fake = fakeHost();
  const long = "word ".repeat(200);
  expect(await showSystemNotification({ id: "n-1", title: "  Reminder  ", body: long }, fake.host)).toBe(true);
  expect(fake.shown.length).toBe(1);
  expect(fake.shown[0].id).toBe("n-1");
  expect(fake.shown[0].tag).toBe("n-1");
  expect(fake.shown[0].title).toBe("Reminder");
  expect(fake.shown[0].body.length).toBe(600);
  expect(fake.shown[0].body.endsWith("…")).toBe(true);
});

test("no notification service or no permission: nothing is tried", async () => {
  for (const permission of ["unsupported", "denied", "default"] as const) {
    const fake = fakeHost({ permission });
    expect(await showSystemNotification({ id: "n-1", title: "Reminder" }, fake.host)).toBe(false);
    expect(fake.shown.length).toBe(0);
  }
  const broken = fakeHost({
    permission: () => {
      throw new Error("the host is gone");
    },
  });
  expect(await showSystemNotification({ id: "n-1", title: "Reminder" }, broken.host)).toBe(false);
  expect(broken.shown.length).toBe(0);
});

test("a notification the host failed to show is not tried a second time", async () => {
  const fake = fakeHost({
    show: () => {
      throw new Error("could not show the notification: no service");
    },
  });
  expect(await showSystemNotification({ id: "n-1", title: "Reminder" }, fake.host)).toBe(false);
  expect(fake.shown.length).toBe(1);
  expect(fake.asked).toEqual(["state"]);
});

test("a run a TODO schedule fired, or a frame without an ID or title, shows nothing", async () => {
  const fake = fakeHost();
  expect(await showSystemNotification({ id: "n-1", title: "Reminder", trigger: "cron" }, fake.host)).toBe(false);
  expect(await showSystemNotification({ id: "", title: "Reminder" }, fake.host)).toBe(false);
  expect(await showSystemNotification({ id: "n-2", title: " " }, fake.host)).toBe(false);
  expect(fake.shown.length).toBe(0);
  expect(fake.asked.length).toBe(0);
});

/* ---------- the permission ---------- */

test("the desktop app's answer is passed on as it is, and a failed one is unsupported", async () => {
  for (const answer of ["granted", "unsupported"] as const) {
    const fake = fakeHost({ request: () => answer });
    expect(await requestSystemNotificationPermission(fake.host)).toBe(answer);
    expect(fake.asked).toEqual(["request"]);
  }
  const broken = fakeHost({
    request: () => {
      throw new Error("timed out");
    },
  });
  expect(await requestSystemNotificationPermission(broken.host)).toBe("unsupported");
  // One question: no second try through another path.
  expect(broken.asked).toEqual(["request"]);
});

test("the browser's answer is passed on as before", async () => {
  const fake = fakeHost({ desktop: false, request: () => "denied" });
  expect(await requestSystemNotificationPermission(fake.host)).toBe("denied");
  expect(fake.asked).toEqual(["request"]);
});

/* ---------- topic task notifications ---------- */

test("a finished topic task in the background notifies with the topic's name, once", async () => {
  const fake = fakeHost();
  const options = { scope: "/", translate, navigate: () => {}, topicTitle: async () => "Release notes", host: fake.host };
  expect(await handleTopicTaskNotification(topicEvent(), options)).toBe(true);
  expect(fake.shown.length).toBe(1);
  expect(fake.shown[0].title).toBe("Release notes");
  expect(fake.shown[0].body).toBe("Task finished");
  // The same event again (a reconnect, a reload): already handled.
  expect(await handleTopicTaskNotification(topicEvent(), options)).toBe(false);
  expect(fake.shown.length).toBe(1);
  expect(await handleTopicTaskNotification(topicEvent({ id: "task-2", status: "failed" }), options)).toBe(true);
  expect(fake.shown[1].body).toBe("Task failed");
});

test("in the foreground, or for a scheduled run, nothing is shown, and the event stays handled", async () => {
  const fake = fakeHost();
  const options = { scope: "/", translate, navigate: () => {}, topicTitle: async () => "Topic", host: fake.host };
  fake.setForeground(true);
  expect(await handleTopicTaskNotification(topicEvent(), options)).toBe(false);
  fake.setForeground(false);
  expect(await handleTopicTaskNotification(topicEvent(), options)).toBe(false);
  expect(await handleTopicTaskNotification(topicEvent({ id: "task-2", trigger: "cron" }), options)).toBe(false);
  expect(fake.shown.length).toBe(0);
});

test("coming back to the window while the topic's name loads shows nothing", async () => {
  const fake = fakeHost();
  const options = {
    scope: "/",
    translate,
    navigate: () => {},
    topicTitle: async () => {
      fake.setForeground(true);
      return "Topic";
    },
    host: fake.host,
  };
  expect(await handleTopicTaskNotification(topicEvent(), options)).toBe(false);
  expect(fake.shown.length).toBe(0);
});

test("a topic notification without the permission, or one the host failed to show, is a no-op once", async () => {
  const unsupported = fakeHost({ permission: "unsupported" });
  const options = { scope: "/", translate, navigate: () => {}, topicTitle: async () => "Topic" };
  expect(await handleTopicTaskNotification(topicEvent(), { ...options, host: unsupported.host })).toBe(false);
  expect(unsupported.shown.length).toBe(0);

  const navigated: string[] = [];
  const failing = fakeHost({
    show: () => {
      throw new Error("could not show the notification");
    },
  });
  const failingOptions = { ...options, navigate: (path: string) => void navigated.push(path), host: failing.host };
  expect(await handleTopicTaskNotification(topicEvent(), failingOptions)).toBe(false);
  expect(await handleTopicTaskNotification(topicEvent(), failingOptions)).toBe(false);
  expect(failing.shown.length).toBe(1);
  // A press the host reports for it anyway leads nowhere.
  failing.press(failing.shown[0].id);
  expect(navigated).toEqual([]);
});

test("pressing a topic notification opens its topic in the local Console, once", async () => {
  const fake = fakeHost();
  const navigated: string[] = [];
  const options = {
    scope: "/",
    translate,
    navigate: (path: string) => void navigated.push(path),
    topicTitle: async () => "Topic",
    host: fake.host,
  };
  expect(await handleTopicTaskNotification(topicEvent({ id: "task-a", topic_id: "topic a" }), options)).toBe(true);
  expect(await handleTopicTaskNotification(topicEvent({ id: "task-b", topic_id: "topic-b" }), options)).toBe(true);
  fake.press("someone else's notification");
  expect(navigated).toEqual([]);
  fake.press(fake.shown[1].id);
  fake.press(fake.shown[0].id);
  fake.press(fake.shown[0].id);
  expect(navigated).toEqual(["/e/default/chat/topic-b", "/e/default/chat/topic%20a"]);
});
