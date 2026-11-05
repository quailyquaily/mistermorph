import assert from "node:assert/strict";
import test from "node:test";
import { handleTopicTaskNotification, topicNotificationPermission, trackNotificationForeground } from "./topic-task-notifications.js";
import { requestBrowserNotificationPermission } from "./system-notification-utils.js";

function sharedBrowserState() {
  const values = new Map();
  const held = [];
  let queue = Promise.resolve();
  return {
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    locks: {
      request(name, options, callback) {
        if (typeof options === "function") {
          callback = options;
          const next = queue.then(callback);
          queue = next.catch(() => {});
          return next;
        }
        if (options.signal.aborted) return Promise.reject(new Error("aborted"));
        const lock = { name };
        held.push(lock);
        return Promise.resolve(callback()).finally(() => held.splice(held.indexOf(lock), 1));
      },
      query: async () => ({ held: [...held] }),
    },
  };
}

function browser(shared = sharedBrowserState()) {
  const win = new EventTarget();
  const doc = new EventTarget();
  let focused = false;
  doc.visibilityState = "hidden";
  doc.hasFocus = () => focused;
  win.document = doc;
  win.navigator = { locks: shared.locks };
  win.localStorage = shared.storage;
  win.isSecureContext = true;
  win.shown = [];
  win.destinations = [];
  win.titleLookups = [];
  win.focus = () => { win.focused = true; };
  win.Notification = class {
    static permission = "granted";
    static requests = 0;
    static async requestPermission() { this.requests++; return "denied"; }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      win.shown.push(this);
    }
    close() { this.closed = true; }
  };
  win.setForeground = (visible, focus) => {
    doc.visibilityState = visible ? "visible" : "hidden";
    focused = focus;
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event(focus ? "focus" : "blur"));
  };
  return win;
}

const event = { type: "topic_task_completed", id: "topic-task:task-1", topic_id: "topic /中文", status: "done" };
function deliver(win, raw = event, overrides = {}) {
  return handleTopicTaskNotification(raw, {
    win,
    scope: "/console",
    translate: (key) => key,
    navigate: (path) => { win.destinations.push(path); },
    topicTitle: async (topicID) => { win.titleLookups.push(topicID); return " Trip plan "; },
    ...overrides,
  });
}

test("success and failure notify in hidden tabs or unfocused windows, with the topic's name and status only and a topic click destination", async () => {
  for (const status of ["done", "failed"]) {
    for (const [visible, focused] of [[false, false], [false, true], [true, false]]) {
      const win = browser();
      win.setForeground(visible, focused);
      assert.equal(await deliver(win, { ...event, status, body: "secret output", title: "secret input", error: "secret error" }), true);
      assert.equal(win.shown.length, 1);
      const notification = win.shown[0];
      // The topic's name as the sidebar shows it, never its ID or anything the event carried.
      assert.equal(notification.title, "Trip plan");
      assert.equal(notification.options.body, `topic_notification_${status}`);
      assert.deepEqual(win.titleLookups, [event.topic_id]);
      notification.onclick();
      assert.equal(win.focused, true);
      assert.equal(notification.closed, true);
      assert.deepEqual(win.destinations, ["/e/default/chat/topic%20%2F%E4%B8%AD%E6%96%87"]);
      assert.equal(win.Notification.requests, 0);
    }
  }
});

test("a topic whose name cannot be read is notified as untitled, never by its ID", async () => {
  const lookups = {
    missing: undefined,
    empty: async () => "  ",
    failing: async () => { throw new Error("offline"); },
    throwing: () => { throw new Error("broken"); },
    "not text": async () => null,
  };
  for (const [name, topicTitle] of Object.entries(lookups)) {
    const win = browser();
    assert.equal(await deliver(win, { ...event, id: `topic-task:${name}` }, { topicTitle }), true, name);
    assert.equal(win.shown[0].title, "chat_topic_untitled", name);
    assert.equal(win.shown[0].options.body, "topic_notification_done", name);
  }
});

test("a name that takes too long does not hold the notification back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const win = browser();
  const delivered = deliver(win, event, { topicTitle: () => new Promise(() => {}) });
  // Let the handler reach the lookup, then pass its 3 seconds.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(win.shown.length, 0);
  t.mock.timers.tick(3000);
  assert.equal(await delivered, true);
  assert.equal(win.shown[0].title, "chat_topic_untitled");
});

test("coming back while the topic's name loads shows nothing, and the completion stays consumed", async () => {
  const shared = sharedBrowserState();
  const win = browser(shared);
  let lookedUp = 0;
  const topicTitle = async () => {
    lookedUp += 1;
    win.setForeground(true, true);
    return "Trip plan";
  };
  assert.equal(await deliver(win, event, { topicTitle }), false);
  assert.equal(lookedUp, 1);
  assert.equal(win.shown.length, 0);
  win.setForeground(false, false);
  assert.equal(await deliver(win), false);
  // A completion seen in the foreground does not ask for the name at all.
  const front = browser();
  front.setForeground(true, true);
  assert.equal(await deliver(front), false);
  assert.deepEqual(front.titleLookups, []);
});

test("foreground completions are consumed and never replayed after hiding or reloading", async () => {
  const shared = sharedBrowserState();
  const win = browser(shared);
  win.setForeground(true, true);
  assert.equal(await deliver(win), false);
  win.setForeground(false, false);
  assert.equal(await deliver(win), false);
  assert.equal(await deliver(browser(shared)), false);
  assert.equal(win.shown.length, 0);
});

test("simultaneous tabs, repeated events, reconnect and reload display a task only once", async () => {
  const shared = sharedBrowserState();
  const tabs = Array.from({ length: 8 }, () => browser(shared));
  const results = await Promise.all(tabs.flatMap((win) => [deliver(win), deliver(win)]));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(tabs.reduce((n, win) => n + win.shown.length, 0), 1);
  assert.equal(await deliver(browser(shared)), false);
  assert.equal(await deliver(tabs[0], { ...event, status: "failed" }), false);
  assert.equal(await deliver(tabs[0], { ...event, id: "topic-task:task-2" }), true);
});

test("another foreground Console suppresses notifications; blur and visibility release its lock", async () => {
  const shared = sharedBrowserState();
  const front = browser(shared);
  front.setForeground(true, true);
  const stop = trackNotificationForeground(front, "/console");
  const back = browser(shared);
  assert.equal(await deliver(back), false);
  front.setForeground(true, false);
  await Promise.resolve();
  assert.equal(await deliver(back, { ...event, id: "second" }), true);
  front.setForeground(true, true);
  assert.equal(await deliver(back, { ...event, id: "third" }), false);
  front.setForeground(false, true);
  await Promise.resolve();
  assert.equal(await deliver(back, { ...event, id: "fourth" }), true);
  front.setForeground(true, true);
  stop();
  await Promise.resolve();
  assert.equal(await deliver(back, { ...event, id: "fifth" }), true);
});

test("denied, default, unsupported, blocked storage and unavailable locks safely no-op without prompting", async () => {
  for (const change of [
    (win) => { win.Notification.permission = "denied"; },
    (win) => { win.Notification.permission = "default"; },
    (win) => { win.isSecureContext = false; },
    (win) => { win.Notification = undefined; },
    (win) => { win.navigator.locks = undefined; },
    (win) => { win.navigator.locks.request = async () => { throw new Error("unavailable"); }; },
    (win) => { Object.defineProperty(win, "localStorage", { get() { throw new Error("blocked"); } }); },
    (win) => { win.localStorage.setItem = () => { throw new Error("quota"); }; },
    (win) => { win.localStorage.getItem = () => { throw new Error("blocked"); }; },
  ]) {
    const win = browser();
    const Notification = win.Notification;
    change(win);
    assert.equal(await deliver(win), false);
    assert.equal(win.shown.length, 0);
    assert.equal(Notification.requests, 0);
  }
  assert.equal(topicNotificationPermission(null), "unsupported");
});

test("malformed data, snapshots, stale connections and empty events cannot notify", async () => {
  const win = browser();
  for (const raw of [null, {}, [], { ...event, id: "" }, { ...event, topic_id: " " }, { ...event, topic_id: {} }, { ...event, status: "running" }, { ...event, type: "snapshot" }]) {
    assert.equal(await deliver(win, raw), false);
  }
  assert.equal(await deliver(win, event, { isCurrent: () => false }), false);
  assert.equal(win.shown.length, 0);
});

test("focus gained while awaiting the claim suppresses delivery", async () => {
  const win = browser();
  const pending = deliver(win);
  win.setForeground(true, true);
  assert.equal(await pending, false);
});

test("Notification constructor failures do not escape or retry the event", async () => {
  const win = browser();
  let attempts = 0;
  win.Notification = class {
    static permission = "granted";
    constructor() { attempts++; throw new Error("unavailable"); }
  };
  assert.equal(await deliver(win), false);
  assert.equal(await deliver(win), false);
  assert.equal(attempts, 1);
});

test("permission is requested explicitly only from default; denied and unsupported never prompt", async () => {
  const win = browser();
  win.Notification.permission = "default";
  assert.equal(await requestBrowserNotificationPermission(win), "denied");
  assert.equal(win.Notification.requests, 1);
  win.Notification.permission = "denied";
  assert.equal(await requestBrowserNotificationPermission(win), "denied");
  win.Notification.permission = "granted";
  assert.equal(await requestBrowserNotificationPermission(win), "granted");
  win.isSecureContext = false;
  assert.equal(await requestBrowserNotificationPermission(win), "unsupported");
  assert.equal(win.Notification.requests, 1);
});

test("installed socket routes live completions, ignores stale sockets and reconnects without fetching history", async () => {
  const requests = [];
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { normalizeConsoleNotification, claimConsoleNotification, resolveBrowserNotificationPermission } = await import("./system-notification-utils.js");
  const source = (await readFile(new URL("./system-notifications.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
    .replace(/^export /gm, "");
  const win = browser();
  let authWatcher;
  let reconnect;
  const sockets = [];
  class Socket {
    constructor() { sockets.push(this); }
    close() { this.onclose?.(); }
  }
  win.setTimeout = (fn) => { reconnect = fn; return 1; };
  win.clearTimeout = () => { reconnect = null; };
  const authValid = { value: true };
  const context = {
    window: win,
    WebSocket: Socket,
    BASE_PATH: "/console",
    authValid,
    watch: (source, callback, options) => {
      assert.equal(source, authValid);
      assert.equal(typeof callback, "function");
      authWatcher = callback;
      if (options.immediate) callback(source.value);
    },
    createConsoleStreamTicket: async () => ({ ticket: "ticket" }),
    buildConsoleNotificationURL: () => "ws://example.test/notifications",
    safeJSON: JSON.parse,
    translate: (key) => key,
    CONSOLE_LOCAL_ENDPOINT_REF: "ep_console_local",
    runtimeApiFetchForEndpoint: async (endpointRef, path) => {
      requests.push(`${endpointRef} ${path}`);
      return { id: event.topic_id, title: "Trip plan" };
    },
    handleTopicTaskNotification,
    trackNotificationForeground,
    normalizeConsoleNotification,
    claimConsoleNotification,
    resolveBrowserNotificationPermission: () => resolveBrowserNotificationPermission(win),
    isDesktopRuntime: () => false,
  };
  runInNewContext(source, context);
  context.installSystemNotifications({ push: (path) => win.destinations.push(path) });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(win.shown.length, 0);
  sockets[0].onmessage({ data: JSON.stringify(event) });
  await flush();
  assert.equal(win.shown.length, 1);
  // The one request is for the notified topic's name, on the local Console.
  assert.equal(win.shown[0].title, "Trip plan");
  assert.deepEqual(requests, ["ep_console_local /topics/topic%20%2F%E4%B8%AD%E6%96%87"]);
  sockets[0].close();
  reconnect();
  await flush();
  assert.equal(sockets.length, 2);
  assert.equal(win.shown.length, 1);
  sockets[0].onmessage({ data: JSON.stringify({ ...event, id: "stale" }) });
  sockets[1].onmessage({ data: JSON.stringify(event) });
  await flush();
  assert.equal(win.shown.length, 1);
  sockets[1].onmessage({ data: JSON.stringify({ id: "cron", title: "Cron", body: "Existing cron body" }) });
  await flush();
  assert.equal(win.shown[1].title, "Cron");
  assert.equal(win.shown[1].options.body, "Existing cron body");
  authValid.value = false;
  authWatcher(false);
  sockets[1].onmessage({ data: JSON.stringify({ ...event, id: "logged-out" }) });
  await flush();
  assert.equal(win.shown.length, 2);
  assert.equal(requests.length, 1);
});
