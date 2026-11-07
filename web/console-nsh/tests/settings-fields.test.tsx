// The settings field controls (components/settings/SettingFields.tsx), mounted on their own
// (tests/fixtures/settings-fields-app.tsx reads each value out as `<name>=<value>`).
import { expect, test } from "nsh/test";
import { openFixture, out } from "./fixtures/settings-fields-open";

test("a select shows the chosen preset's title and saves the picked value", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("label:Level");
  expect(app.shows("text:Info (default)")).toBe(true);
  await app.press("label:Level");
  await app.press("text:Warn");
  await app.waitUntil(() => out(app, "select") === "warn");
  expect(app.shows("text:Warn")).toBe(true);
});

test("a select that allows a custom value takes a typed one and offers the presets", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("id:custom");
  // Not focused, the box names the preset.
  expect(app.value("id:custom")).toBe("Every 30 minutes");
  await app.clear("id:custom");
  await app.type("id:custom", "45m");
  await app.waitUntil(() => out(app, "custom") === "45m");
  await app.press("label:Interval: show choices");
  await app.press("text:Every hour");
  await app.waitUntil(() => out(app, "custom") === "1h");
});

test("a duration is an amount and a unit, and stored text the units cannot show stays raw", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("id:duration");
  expect(app.value("id:duration")).toBe("30");
  await app.clear("id:duration");
  await app.type("id:duration", "1x5");
  // A letter is dropped.
  await app.waitUntil(() => out(app, "duration") === "15m");
  expect(app.value("id:duration")).toBe("15");
  await app.press("label:Timeout: unit, minutes");
  await app.press("text:hours");
  await app.waitUntil(() => out(app, "duration") === "15h");
  // Zero with a meaning shows empty, with what it means.
  expect(app.value("id:duration-zero")).toBe("");
  expect(app.shows("text:Same as run timeout")).toBe(true);
  // 500ms is no whole unit: plain text.
  expect(app.value("id:duration-raw")).toBe("500ms");
  await app.type("id:duration-raw", "0");
  await app.waitUntil(() => out(app, "duration-raw") === "500ms0");
});

test("a byte size picks the largest whole unit and saves whole bytes", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("id:bytes");
  expect(app.value("id:bytes")).toBe("512");
  expect(app.shows("text:MB")).toBe(true);
  await app.press("label:Size: unit, MB");
  await app.press("text:KB");
  await app.waitUntil(() => out(app, "bytes") === String(512 * 1024));
});

test("a limit turns on with its last value and off to zero", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("text:No limit");
  await app.press("text:Set limit");
  await app.waitUntil(() => out(app, "limit") === "200000");
  await app.clear("id:limit");
  await app.type("id:limit", "12a3");
  await app.waitUntil(() => out(app, "limit") === "123");
  await app.press("text:No limit");
  await app.waitUntil(() => out(app, "limit") === "0");
  await app.press("text:Set limit");
  await app.waitUntil(() => out(app, "limit") === "123");
});

test("a path is typed, and Browse fills it from the folder picker", async () => {
  const { app } = await openFixture("/fields", {}, { host: { "morph.desktop.pickDirectory": "/home/me/logs" } });
  await app.waitFor("id:path");
  await app.type("id:path", "/tmp");
  await app.waitUntil(() => out(app, "path") === "/tmp");
  await app.press("text:Browse");
  await app.waitUntil(() => out(app, "path") === "/home/me/logs");
});

test("a path whose folder picker fails says so", async () => {
  const { app } = await openFixture("/fields", {}, {
    host: {
      "morph.desktop.pickDirectory": () => {
        throw new Error("no picker here");
      },
    },
  });
  await app.waitFor("text:Browse");
  await app.press("text:Browse");
  await app.waitFor("text:no picker here");
});

test("a percent reads its ratio as a percentage", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("text:50");
  expect(out(app, "percent")).toBe("0.5");
});

test("choices toggle on and off, and a locked one stays as it is", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("label:POST");
  await app.press("label:POST");
  await app.waitUntil(() => out(app, "choices") === '["GET","POST"]');
  await app.press("label:GET");
  await app.waitUntil(() => out(app, "choices") === '["POST"]');
  expect(app.enabled("label:PUT")).toBe(false);
});

test("list rows edit, add and remove values", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("label:Paths: value 1");
  expect(app.value("label:Paths: value 1")).toBe("~/.ssh");
  await app.type("label:Paths: value 2", "/x");
  await app.waitUntil(() => out(app, "rows-list") === "~/.ssh\n/etc/x");
  await app.press("text:Add path");
  await app.type("label:Paths: value 3", "/var");
  await app.waitUntil(() => out(app, "rows-list") === "~/.ssh\n/etc/x\n/var");
  await app.press("id:rows-list >> label:Remove row 1");
  await app.waitUntil(() => out(app, "rows-list") === "/etc/x\n/var");
});

test("map rows write a JSON object, and JSON they cannot show goes to the fallback", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("label:Headers: Name 1");
  expect(app.value("label:Headers: Value 1")).toBe("a");
  await app.type("label:Headers: Value 1", "b");
  await app.waitUntil(() => out(app, "rows-map") === '{\n  "X-Token": "ab"\n}');
  expect(app.shows("id:rows-fallback")).toBe(true);
});

test("identity rows pick their platform from the list", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("label:Admins: platform, Telegram");
  await app.press("label:Admins: platform, Telegram");
  await app.press("text:Slack");
  await app.waitUntil(() => out(app, "rows-identities") === "slack:42");
});

test("a pattern row says when its expression is not valid", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("text:Add pattern");
  await app.press("text:Add pattern");
  await app.type("label:Patterns: Name 1", "card");
  await app.type("label:Patterns: Regular expression 1", "([");
  await app.waitFor("text:Not a valid regular expression.");
});

test("disabled fields take no input", async () => {
  const { app } = await openFixture("/fields");
  await app.waitFor("id:toggle-disabled");
  await app.press("id:toggle-disabled");
  await app.waitFor("text:disabled=true");
  expect(app.enabled("label:Level")).toBe(false);
  expect(app.enabled("id:custom")).toBe(false);
  expect(app.enabled("id:duration")).toBe(false);
});
