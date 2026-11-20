// The phone app's console server on the login page (pages/login/LoginPage.tsx, ServerDialog.tsx):
// the card names the server and the button that changes it, the dialog takes a typed address or
// one read from a QR code, and only Save checks and saves it. A scan fills the field and nothing
// else: no request goes to the scanned address, nothing is saved and nobody is logged in; a code
// that holds no address, a refused or missing camera and a scanner that is not there say so and
// leave the field to type in. The scanner's page is stood in for by tests/loginProbeConsole.tsx
// (a headless web view runs no page): its own test is lib/qrScannerPage.test.mjs.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { type ApiRequest, loginProbe, MOBILE_SERVER_KEY, openConsole, ORIGIN } from "./harness";

const saved = (app: App) => String(app.storage()[MOBILE_SERVER_KEY] || "");
/** The requests that went to `host`, whatever they asked. */
const sentTo = (calls: ApiRequest[], host: string) => calls.filter((call) => String(call.url).includes(host));
const logins = (calls: ApiRequest[]) => calls.filter((call) => call.path === "/auth/login");

/** A scan's note under the field: which kind, and what it says. */
async function noted(app: App, id: string, text: string) {
  await app.waitFor(`id:${id}`);
  await app.waitFor(`text:${text}`);
}

async function openLogin(options: Parameters<typeof openConsole>[0] = {}) {
  const opened = await openConsole({ platform: "android", password: true, loginProbe: true, location: "/login", ...options });
  await opened.app.waitFor("id:login-password");
  return { ...opened, probe: loginProbe(opened.app) };
}

async function openDialog(app: App) {
  await app.press("id:login-server-open");
  await app.waitFor("id:login-server-input");
}

async function startScan(app: App) {
  await app.press("id:login-server-scan");
  await app.waitFor("id:login-server-camera");
}

test("the card names the server and a labeled button changes it; a typed address is checked, saved and shown", async () => {
  const { app, calls } = await openLogin();
  // What the server is and what the button does are words, not an icon to guess at.
  await app.waitFor("id:login-server >> text:SERVER");
  await app.waitFor(`id:login-server >> text:${ORIGIN}`);
  await app.waitFor("role:button[Change server]");
  await app.waitFor("The Morph console this app signs in to.");

  await openDialog(app);
  expect(app.value("id:login-server-input")).toBe(ORIGIN);
  await app.waitFor("Server address");
  await app.waitFor("For example 192.168.1.5:9080 or https://morph.example.com");
  await app.waitFor("role:button[Scan QR code]");

  // Not an http(s) address: said under the field, nothing asked or saved.
  await app.clear("id:login-server-input");
  await app.type("id:login-server-input", "ftp://files.example.com");
  await app.press("id:login-server-save");
  await app.waitFor("Enter the console's address (http:// or https://)");
  expect(sentTo(calls, "files.example.com")).toHaveLength(0);
  expect(saved(app)).toBe(ORIGIN);

  // An address as typed, without a scheme: checked there, then saved.
  await app.clear("id:login-server-input");
  await app.type("id:login-server-input", "192.168.1.20:9080/");
  await app.press("id:login-server-save");
  await app.waitFor("id:login-server-dialog", { state: "gone" });
  expect(saved(app)).toBe("http://192.168.1.20:9080");
  expect(String(sentTo(calls, "192.168.1.20:9080")[0].url)).toBe("http://192.168.1.20:9080/api/auth/config");
  await app.waitFor("id:login-server >> text:http://192.168.1.20:9080");
  await app.waitFor("role:button[Change server]");
  // Saving a server logs nobody in: the password is still the user's to give.
  expect(logins(calls)).toHaveLength(0);
});

test("without a server the dialog opens by itself, and the card says none is set", async () => {
  const { app } = await openConsole({ platform: "android", password: true, loginProbe: true, location: "/login", kv: { [MOBILE_SERVER_KEY]: "" } });
  await app.waitFor("id:login-server-input");
  expect(app.value("id:login-server-input")).toBe("");
  expect(app.enabled("id:login-server-save")).toBe(false);
  await app.back();
  await app.waitFor("id:login-server-dialog", { state: "gone" });
  await app.waitFor("id:login-server >> text:No server set yet");
  await app.waitFor("role:button[Set server]");
});

test("a server that does not answer is not saved", async () => {
  const { app, calls } = await openLogin({
    api: { "GET /auth/config": (request) => (String(request.url).includes("10.0.0.9") ? { status: 503, body: {} } : { body: { password_required: true } }) },
  });
  await openDialog(app);
  await app.clear("id:login-server-input");
  await app.type("id:login-server-input", "10.0.0.9:9080");
  await app.press("id:login-server-save");
  await app.waitFor("No console answered at http://10.0.0.9:9080: HTTP 503");
  expect(sentTo(calls, "10.0.0.9")).toHaveLength(1);
  expect(saved(app)).toBe(ORIGIN);
  // Still there to correct.
  expect(app.value("id:login-server-input")).toBe("10.0.0.9:9080");
});

test("a scanned address only fills the field: Save is the user's, and nothing reaches the address before it", async () => {
  const { app, calls, probe } = await openLogin();
  await openDialog(app);
  const before = calls.length;
  await startScan(app);
  // The camera is in the field's place, with what to do and a way out.
  expect(app.shows("id:login-server-input")).toBe(false);
  expect(app.shows("id:login-server-save")).toBe(false);
  await app.waitFor("Starting the camera. Allow camera access if you are asked.");
  await app.waitFor("role:button[Stop scanning]");
  await probe.say({ type: "ready" });
  await app.waitFor("Point the camera at a QR code of the server address.");

  await probe.say({ type: "result", text: "http://192.168.1.20:9080/console/?from=qr" });
  await app.waitFor("id:login-server-input");
  expect(app.value("id:login-server-input")).toBe("http://192.168.1.20:9080/console");
  await noted(app, "login-server-scan-filled", "Scanned address filled in. Check it, then press Save.");
  // The camera is gone and its page was told to stop.
  expect(app.shows("id:login-server-camera")).toBe(false);
  expect(await probe.scans()).toEqual([{ state: "closed", told: ["stop", "stop"], attached: true }]);
  // A draft: nothing asked of anyone, nothing saved, nobody logged in, the dialog still open.
  await app.wait(300);
  expect(calls.length).toBe(before);
  expect(sentTo(calls, "192.168.1.20")).toHaveLength(0);
  expect(logins(calls)).toHaveLength(0);
  expect(saved(app)).toBe(ORIGIN);
  expect(app.shows("id:login-server-dialog")).toBe(true);
  await app.waitFor(`id:login-server >> text:${ORIGIN}`);

  // The scanned address is the user's to change before saving.
  await app.clear("id:login-server-input");
  await app.type("id:login-server-input", "http://192.168.1.20:9080");
  expect(app.shows("id:login-server-scan-filled")).toBe(false);
  await app.press("id:login-server-save");
  await app.waitFor("id:login-server-dialog", { state: "gone" });
  expect(saved(app)).toBe("http://192.168.1.20:9080");
  // The check, then the page asking the new server whether it wants a password: no password is sent.
  expect(sentTo(calls, "192.168.1.20").length).toBeGreaterThan(0);
  expect(sentTo(calls, "192.168.1.20").every((call) => call.method === "GET" && call.path === "/auth/config")).toBe(true);
  expect(logins(calls)).toHaveLength(0);
});

test("a scanned address saved unchanged goes through the same check as a typed one", async () => {
  const { app, calls, probe } = await openLogin({
    api: { "GET /auth/config": (request) => (String(request.url).includes("10.0.0.9") ? { status: 503, body: {} } : { body: { password_required: true } }) },
  });
  await openDialog(app);
  await startScan(app);
  await probe.say({ type: "result", text: "10.0.0.9:9080" });
  await app.waitFor("id:login-server-input");
  expect(app.value("id:login-server-input")).toBe("http://10.0.0.9:9080");
  expect(sentTo(calls, "10.0.0.9")).toHaveLength(0);
  await app.press("id:login-server-save");
  await app.waitFor("No console answered at http://10.0.0.9:9080: HTTP 503");
  expect(saved(app)).toBe(ORIGIN);
});

test("a code that holds no address says so and leaves the field as it was, to type in or scan again", async () => {
  const { app, calls, probe } = await openLogin();
  await openDialog(app);
  await app.clear("id:login-server-input");
  await app.type("id:login-server-input", "10.0.0.5:9080");
  const before = calls.length;
  const codes = ["WIFI:S:home;T:WPA;P:secret;;", '{"server":"http://evil.test","password":"x"}', "http://admin:secret@evil.test", "ftp://evil.test", "hello world"];
  for (const text of codes) {
    await startScan(app);
    await probe.say({ type: "ready" });
    await probe.say({ type: "result", text });
    await noted(app, "login-server-scan-error", "That QR code does not hold a server address (http:// or https://). The address was left as it was.");
    expect({ text, value: app.value("id:login-server-input") }).toEqual({ text, value: "10.0.0.5:9080" });
    expect(app.shows("id:login-server-camera")).toBe(false);
  }
  expect((await probe.scans()).map((scan) => scan.state)).toEqual(codes.map(() => "closed"));
  expect(calls.length).toBe(before);
  expect(saved(app)).toBe(ORIGIN);
  // Typing takes the note away and goes on as before.
  await app.type("id:login-server-input", "1");
  expect(app.shows("id:login-server-scan-error")).toBe(false);
  await app.waitFor("id:login-server-scan-help");
  expect(app.value("id:login-server-input")).toBe("10.0.0.5:90801");
  // What is not one of the page's messages is not heard at all: the scan goes on.
  await startScan(app);
  await probe.say("save http://evil.test");
  await probe.say({ type: "result", text: 42 });
  await app.wait(100);
  expect(app.shows("id:login-server-camera")).toBe(true);
});

test("no camera, no permission and no scanner each say why, and the address can still be typed or scanned again", async () => {
  const { app, probe } = await openLogin();
  await openDialog(app);
  const failures: [string, string][] = [
    ["denied", "Camera access was not allowed. Allow the camera for Morph in the system settings, or type the address."],
    ["no_camera", "No camera was found. Type the address instead."],
    ["unsupported", "QR scanning is not available on this device. Type the address instead."],
    ["busy", "The camera could not be started; another app may be using it. Try again, or type the address."],
    ["interrupted", "Scanning stopped because the app left the screen. Try again, or type the address."],
    ["exploded", "Scanning did not work. Try again, or type the address."],
  ];
  for (const [code, text] of failures) {
    await startScan(app);
    await probe.say({ type: "error", code });
    await noted(app, "login-server-scan-error", `${text}`);
    expect(app.shows("id:login-server-camera")).toBe(false);
    expect({ code, value: app.value("id:login-server-input") }).toEqual({ code, value: ORIGIN });
    expect(app.enabled("id:login-server-scan")).toBe(true);
    expect(app.enabled("id:login-server-save")).toBe(true);
  }
  // After a failure a scan works as the first would.
  await startScan(app);
  expect(app.shows("id:login-server-scan-error")).toBe(false);
  await probe.say({ type: "result", text: "https://morph.example.com" });
  await app.waitFor("id:login-server-scan-filled");
  expect(app.value("id:login-server-input")).toBe("https://morph.example.com");
  expect(saved(app)).toBe(ORIGIN);
});

test("Stop scanning brings the field back as it was, and what its page says late is dropped", async () => {
  const { app, calls, probe } = await openLogin();
  await openDialog(app);
  await app.clear("id:login-server-input");
  await app.type("id:login-server-input", "10.0.0.5:9080");
  await startScan(app);
  await app.press("id:login-server-scan-stop");
  await app.waitFor("id:login-server-input");
  expect(app.shows("id:login-server-camera")).toBe(false);
  expect(app.value("id:login-server-input")).toBe("10.0.0.5:9080");
  expect(await probe.scans()).toEqual([{ state: "closed", told: ["stop"], attached: true }]);
  // The permission answered, or a code read, after the scanner closed.
  const before = calls.length;
  await probe.say({ type: "ready" }, 0);
  await probe.say({ type: "result", text: "http://evil.test" }, 0);
  await probe.say({ type: "error", code: "denied" }, 0);
  await app.wait(200);
  expect(app.value("id:login-server-input")).toBe("10.0.0.5:9080");
  expect(app.shows("id:login-server-scan-error")).toBe(false);
  expect(app.shows("id:login-server-scan-filled")).toBe(false);
  expect(app.shows("id:login-server-camera")).toBe(false);
  expect(calls.length).toBe(before);
  // An earlier scan's page cannot speak into a later scan either.
  await startScan(app);
  await probe.say({ type: "result", text: "http://evil.test" }, 0);
  await app.wait(100);
  expect(app.shows("id:login-server-camera")).toBe(true);
  await probe.say({ type: "result", text: "http://10.0.0.6:9080" }, 1);
  await app.waitFor("id:login-server-scan-filled");
  expect(app.value("id:login-server-input")).toBe("http://10.0.0.6:9080");
});

test("closing the dialog during a scan stops the camera, and the next opening starts from the saved address", async () => {
  const { app, probe } = await openLogin();
  await openDialog(app);
  await startScan(app);
  await probe.say({ type: "ready" });
  // Android's Back closes the dialog.
  await app.back();
  await app.waitFor("id:login-server-dialog", { state: "gone" });
  expect(await probe.scans()).toEqual([{ state: "closed", told: ["stop"], attached: true }]);
  await probe.say({ type: "result", text: "http://evil.test" }, 0);
  expect(saved(app)).toBe(ORIGIN);
  await app.waitFor(`id:login-server >> text:${ORIGIN}`);

  await openDialog(app);
  expect(app.shows("id:login-server-camera")).toBe(false);
  expect(app.value("id:login-server-input")).toBe(ORIGIN);
  expect(app.shows("id:login-server-scan-filled")).toBe(false);
  // The dialog's own close button, during a scan.
  await startScan(app);
  await app.press("id:login-server-dialog-close");
  await app.waitFor("id:login-server-dialog", { state: "gone" });
  expect((await probe.scans()).map((scan) => scan.state)).toEqual(["closed", "closed"]);
  expect((await probe.scans())[1].told).toEqual(["stop"]);
});

test("the app leaving the screen ends a scan and releases the camera", async () => {
  const { app, probe } = await openLogin();
  await openDialog(app);
  await startScan(app);
  await probe.say({ type: "ready" });
  // The system's permission question only covers the app: the scan it belongs to goes on.
  await app.setLifecycle("inactive");
  await app.setLifecycle("active");
  expect(app.shows("id:login-server-camera")).toBe(true);
  expect((await probe.scans())[0].state).toBe("open");
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await noted(app, "login-server-scan-error", "Scanning stopped because the app left the screen. Try again, or type the address.");
  expect(app.shows("id:login-server-camera")).toBe(false);
  const [scan] = await probe.scans();
  expect(scan.state).toBe("closed");
  expect(scan.told[0]).toBe("stop");
});

test("leaving the login page during a scan stops the camera", async () => {
  // A console without a password: /login?stay keeps the page until something moves on.
  const { app, calls } = await openConsole({ platform: "android", loginProbe: true, location: "/login?stay=1" });
  const probe = loginProbe(app);
  await app.waitFor("id:login-password");
  await openDialog(app);
  await startScan(app);
  await probe.say({ type: "ready" });
  expect((await probe.scans())[0].state).toBe("open");
  await app.host.send("morph.fixture.navigate", { to: "/overview" });
  await app.waitFor("id:login-password", { state: "gone" });
  const [scan] = await probe.scans();
  expect(scan).toEqual({ state: "closed", told: ["stop"], attached: true });
  // What its page says after is nobody's.
  const before = calls.length;
  await probe.say({ type: "result", text: "http://evil.test" }, 0);
  await app.wait(100);
  expect(sentTo(calls, "evil.test")).toHaveLength(0);
  expect(calls.length).toBe(before);
  expect(String(app.storage()[MOBILE_SERVER_KEY])).toBe(ORIGIN);
});

for (const width of [320, 390]) {
  test(`at ${width}pt a long server address wraps inside the card and its button stays whole`, async () => {
    const long = "https://morph-console.internal.example-company.com:9443/teams/platform/tools/console";
    const { app, probe } = await openLogin({ width, kv: { [MOBILE_SERVER_KEY]: long } });
    await app.waitFor(`id:login-server >> text:${long}`);
    const frames = await probe.frames(["column", "server", "server.change", "password.box"]);
    const column = frames.column;
    // The column is the window less its margins; nothing in it is wider.
    expect(column.x).toBeGreaterThanOrEqual(16);
    expect(column.x + column.w).toBeLessThanOrEqual(width - 16 + 0.5);
    expect(frames.server.w).toBeLessThanOrEqual(column.w);
    const change = frames["server.change"];
    expect(change.x).toBeGreaterThan(0);
    expect(change.x + change.w).toBeLessThanOrEqual(frames.server.w + 0.5);
    expect(Math.round(change.h)).toBe(32);
    // The label is not cut: wider than its text needs at 12pt.
    expect(change.w).toBeGreaterThan(90);
    expect(frames["password.box"].w).toBeLessThanOrEqual(frames.server.w + 0.5);
    // The dialog's field holds the whole address to edit.
    await openDialog(app);
    expect(app.value("id:login-server-input")).toBe(long);
  });
}
