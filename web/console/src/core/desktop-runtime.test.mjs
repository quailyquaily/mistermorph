import assert from "node:assert/strict";
import test from "node:test";

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    key(index) {
      return Array.from(values.keys())[index] || null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function installDesktopWindow() {
  const listeners = new Map();
  const win = {
    __MISTERMORPH_DESKTOP_RUNTIME__: true,
    location: {
      pathname: "/window/test",
      search: "",
    },
    localStorage: createLocalStorage(),
    setTimeout,
    clearTimeout,
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || new Set();
      callbacks.add(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    dispatchDesktopEvent(type, event) {
      Array.from(listeners.get(type) || []).forEach((callback) => callback(event));
    },
  };
  globalThis.window = win;
  return win;
}

async function importDesktopRuntime() {
  const url = new URL("./desktop-runtime.js", import.meta.url);
  url.search = `test=${Date.now()}-${Math.random()}`;
  return await import(url.href);
}

test("desktop update check uses configured binding name", async () => {
  const win = installDesktopWindow();
  const calls = [];
  win.__MISTERMORPH_DESKTOP_BINDINGS__ = {
    CheckUpdate: "custom.App.CheckUpdate",
  };
  win.wails = {
    Call: {
      ByName(name, ...args) {
        calls.push([name, ...args]);
        if (name === "custom.App.CheckUpdate") {
          return { status: "up_to_date" };
        }
        return true;
      },
    },
  };

  const { canCheckDesktopUpdate, checkDesktopUpdate } = await importDesktopRuntime();
  assert.equal(canCheckDesktopUpdate(), true);
  assert.deepEqual(await checkDesktopUpdate(), { status: "up_to_date" });
  assert.deepEqual(await checkDesktopUpdate("community"), { status: "up_to_date" });
  assert.deepEqual(calls, [
    ["custom.App.CheckUpdate", null],
    ["custom.App.CheckUpdate", "community"],
  ]);
});

test("desktop notifications use configured native bindings", async () => {
  const win = installDesktopWindow();
  const calls = [];
  win.__MISTERMORPH_DESKTOP_BINDINGS__ = {
    RequestNotificationPermission: "custom.App.RequestNotificationPermission",
    ShowNotification: "custom.App.ShowNotification",
  };
  win.wails = {
    Call: {
      ByName(name, ...args) {
        calls.push([name, ...args]);
        return true;
      },
    },
  };

  const {
    canUseDesktopNotifications,
    requestDesktopNotificationPermission,
    showDesktopNotification,
  } = await importDesktopRuntime();
  assert.equal(canUseDesktopNotifications(), true);
  assert.equal(await requestDesktopNotificationPermission(), true);
  assert.equal(await showDesktopNotification({ id: "run-1", title: "Task", body: "Done" }), true);
  assert.deepEqual(calls, [
    ["custom.App.RequestNotificationPermission"],
    ["custom.App.ShowNotification", { id: "run-1", title: "Task", body: "Done" }],
  ]);
});

test("desktop runtime does not expose an unused notification permission check", async () => {
  installDesktopWindow();
  const runtime = await importDesktopRuntime();
  assert.equal(runtime.checkDesktopNotificationPermission, undefined);
});

test("desktop runtime exposes injected version", async () => {
  const win = installDesktopWindow();
  win.__MISTERMORPH_DESKTOP_VERSION__ = "0.2.42";

  const { desktopRuntimeVersion } = await importDesktopRuntime();

  assert.equal(desktopRuntimeVersion(), "0.2.42");
});
