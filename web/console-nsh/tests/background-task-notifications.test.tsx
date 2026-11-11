// The phone app's task notifications on the console's side (lib/core/background-task-notifications.js)
// with stand-ins for the native part: what it is configured with as the session and language
// change, when a pressed notification's topic is taken and where it opens, and that the page's
// own topic notifications step aside where the native part tells of them (no completion twice),
// as does the TODO items' opt-in notification, which the phone app does not show.
import { expect, test } from "nsh/test";
import { effect, signal, untracked } from "nsh";
import {
  backgroundNotificationSettings,
  installBackgroundTaskNotifications,
  openNotifiedTopic,
} from "../lib/core/background-task-notifications.js";
import { requestSystemNotificationPermission } from "../lib/core/system-notifications.js";
import { handleTopicTaskNotification } from "../lib/core/topic-task-notifications.js";
import { boot, localStore } from "../lib/platform";

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const translate = (key: string) => `[${key}]`;

test("settings carry the session only while signed in, and the texts in the language", () => {
  const on = backgroundNotificationSettings({ api: "https://c.test/api", token: "t", valid: true, translate });
  expect(on).toEqual({
    api: "https://c.test/api",
    token: "t",
    texts: {
      untitled: "[chat_topic_untitled]",
      done: "[topic_notification_done]",
      failed: "[topic_notification_failed]",
      channel: "[topic_notifications_title]",
    },
  });
  expect(backgroundNotificationSettings({ api: "https://c.test/api", token: "t", valid: false, translate }).token).toBe("");
});

test("a pressed topic opens when it exists, the chat when it is gone or unreadable, nothing signed out", async () => {
  const paths: string[] = [];
  const navigate = (path: string) => paths.push(path);
  const signedIn = () => true;
  expect(await openNotifiedTopic("topic 1", { signedIn, navigate, topicExists: async () => ({ id: "topic 1" }) })).toBe(true);
  expect(await openNotifiedTopic("gone", { signedIn, navigate, topicExists: async () => null })).toBe(false);
  expect(
    await openNotifiedTopic("broken", {
      signedIn,
      navigate,
      topicExists: async () => {
        throw new Error("403");
      },
    }),
  ).toBe(false);
  expect(paths).toEqual(["/e/default/chat/topic%201", "/e/default/chat", "/e/default/chat"]);

  await openNotifiedTopic("topic-1", { signedIn: () => false, navigate, topicExists: async () => true });
  await openNotifiedTopic("", { signedIn, navigate, topicExists: async () => true });
  // Signed out while the topic was checked.
  let valid = true;
  await openNotifiedTopic("topic-1", {
    signedIn: () => valid,
    navigate,
    topicExists: async () => {
      valid = false;
      return true;
    },
  });
  expect(paths.length).toBe(3);
});

test("configured on sign-in, language change and sign-out; pressed topics taken only signed in", async () => {
  const signedIn = signal(false);
  const token = signal("");
  const language = signal("en");
  const configured: any[] = [];
  const pressed: string[] = ["topic-1"];
  const paths: string[] = [];
  let openedListener: (() => void) | null = null;
  let takes = 0;
  effect(() =>
    untracked(() =>
      installBackgroundTaskNotifications({
        configure: async (settings: any) => {
          configured.push(settings);
          // A native part that refuses must not break anything.
          if (configured.length === 1) throw new Error("no native part");
        },
        take: async () => {
          takes += 1;
          return pressed.shift() || "";
        },
        onOpened: (listener: () => void) => {
          openedListener = listener;
          return () => {};
        },
        api: () => "http://c.test/api",
        token,
        signedIn,
        language,
        translate: (key: string) => `${language()}:${key}`,
        topicExists: async () => true,
        navigate: (path: string) => paths.push(path),
      }),
    ),
  );
  await settle();
  expect(configured.length).toBe(1);
  expect(configured[0].token).toBe("");
  expect(takes).toBe(0);

  token.set("token-1");
  signedIn.set(true);
  await settle();
  expect(configured.at(-1).token).toBe("token-1");
  expect(paths).toEqual(["/e/default/chat/topic-1"]);

  language.set("zh");
  await settle();
  expect(configured.at(-1).texts.done).toBe("zh:topic_notification_done");

  pressed.push("topic-2");
  openedListener!();
  await settle();
  expect(paths).toEqual(["/e/default/chat/topic-1", "/e/default/chat/topic-2"]);

  signedIn.set(false);
  await settle();
  expect(configured.at(-1).token).toBe("");
  const before = takes;
  openedListener!();
  await settle();
  expect(takes).toBe(before);
});

test("the page's own topic notifications step aside where the native part tells of them", async () => {
  const titles: string[] = [];
  const options = {
    scope: "/",
    translate,
    navigate: () => {},
    topicTitle: (id: string) => {
      titles.push(id);
      return "Ops";
    },
  };
  const event = (id: string) => ({ type: "topic_task_completed", id, topic_id: "topic-1", status: "done" });
  // A browser: the completion is the page's (consumed here; no permission without a host).
  expect(await handleTopicTaskNotification(event("topic-task:web"), options)).toBe(false);
  expect(localStore.getItem("mistermorph_topic_notifications_v1:/:task:topic-task:web")).toBe("1");

  // The phone app with its native part: the page leaves it alone.
  await boot({ features: ["backgroundTaskNotifications"] });
  expect(await handleTopicTaskNotification(event("topic-task:phone"), options)).toBe(false);
  expect(localStore.getItem("mistermorph_topic_notifications_v1:/:task:topic-task:phone")).toBe(null);
  expect(titles.length).toBe(0);
  // Nor does a TODO item's opt-in notification claim it can show there.
  expect(await requestSystemNotificationPermission()).toBe("unsupported");
});
