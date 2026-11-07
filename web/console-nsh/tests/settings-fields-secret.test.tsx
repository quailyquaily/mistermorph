// SecretInput, SecretKeyPicker and EnvManagedField (components/settings), mounted on their own.
import { expect, test } from "nsh/test";
import { openFixture, out } from "./fixtures/settings-fields-open";

const KEYS = {
  keys: [
    {
      id: "k1",
      kind: "env",
      hint: "sk-…a1b2",
      ref: "${OPENAI_KEY}",
      used_by: ["llm.api_key"],
    },
    {
      id: "k2",
      kind: "file",
      hint: "sk-…c3d4",
      reveal_path: "telegram.bot_token",
      used_by: ["telegram.bot_token"],
    },
  ],
  fields: {},
};

test("a stored secret shows masked with where it is kept, and the eye shows it", async () => {
  const { app, calls } = await openFixture("/secret", {
    "POST /secrets/reveal": { body: { value: "sk-live-1234" } },
  });
  await app.waitFor("id:secret-stored");
  expect(app.texts()).toContain("PLAIN TEXT");
  await app.press("id:secret-stored >> label:Show");
  await app.waitFor("text:sk-live-1234");
  expect(calls.find((call) => call.path === "/secrets/reveal")?.json).toEqual({ path: "llm.api_key", password: "" });
  await app.press("id:secret-stored >> label:Hide");
  await app.waitUntil(() => !app.shows("text:sk-live-1234"));
});

test("revealing asks for the console password, and a wrong one says so", async () => {
  const { app } = await openFixture("/secret", {
    "GET /secrets/info": { body: { reveal: true, password_required: true } },
    "POST /secrets/reveal": (call) =>
      call.json?.password === "right" ? { body: { value: "sk-live-9" } } : { status: 403, body: { error: "forbidden" } },
  });
  await app.waitFor("id:secret-stored");
  await app.press("id:secret-stored >> label:Show");
  await app.waitFor("id:secret-stored-password");
  await app.type("id:secret-stored-password", "wrong");
  await app.submit("id:secret-stored-password");
  await app.waitFor("text:Incorrect password.");
  await app.type("id:secret-stored-password", "right");
  await app.submit("id:secret-stored-password");
  await app.waitFor("text:sk-live-9");
});

test("the pencil opens an empty field for a new value, and undo keeps the current one", async () => {
  const { app } = await openFixture("/secret");
  await app.waitFor("id:secret-stored");
  await app.press("id:secret-stored >> label:Replace");
  await app.waitFor("id:secret-stored-input");
  await app.type("id:secret-stored-input", "sk-new");
  await app.waitUntil(() => out(app, "secret-stored") === "sk-new");
  await app.press("id:secret-stored >> label:Keep current");
  await app.waitUntil(() => out(app, "secret-stored") === "");
  expect(app.texts()).toContain("PLAIN TEXT");
});

test("the secret picker hands over another field's key reference", async () => {
  const { app } = await openFixture("/secret", { "GET /secrets/keys": { body: KEYS } });
  await app.waitFor("id:secret-fresh");
  await app.press("id:secret-fresh >> label:Use a saved key");
  await app.waitFor("text:sk-…a1b2");
  await app.press("text:sk-…a1b2");
  await app.waitUntil(() => out(app, "secret-fresh") === "${OPENAI_KEY}");
  // A variable shows by its name; undo drops the pick.
  await app.waitFor("text:OPENAI_KEY");
  await app.press("id:secret-fresh >> label:Don't use this key");
  await app.waitUntil(() => out(app, "secret-fresh") === "");
});

test("a plain-text key is revealed to be handed over", async () => {
  const { app } = await openFixture("/secret", {
    "GET /secrets/keys": { body: KEYS },
    "POST /secrets/reveal": (call) =>
      call.json?.path === "telegram.bot_token" ? { body: { value: "123:abc" } } : { status: 404, body: { error: "no" } },
  });
  await app.waitFor("id:secret-fresh");
  await app.press("id:secret-fresh >> label:Use a saved key");
  await app.waitFor("text:sk-…c3d4");
  await app.press("text:sk-…c3d4");
  await app.waitUntil(() => out(app, "secret-fresh") === "123:abc");
});

test("the picker says when the keys cannot be loaded, or there are none", async () => {
  const { app } = await openFixture("/secret", { "GET /secrets/keys": { status: 500, body: { error: "store locked" } } });
  await app.waitFor("id:secret-fresh");
  await app.press("id:secret-fresh >> label:Use a saved key");
  await app.waitFor("text:store locked");

  const empty = await openFixture("/secret");
  await empty.app.waitFor("id:secret-fresh");
  await empty.app.press("id:secret-fresh >> label:Use a saved key");
  await empty.app.waitFor("text:No other keys are saved yet.");
});

test("a variable-managed field shows locked and copies the variable's name", async () => {
  const { app } = await openFixture("/secret");
  await app.waitFor("text:OPENAI_API_KEY");
  await app.press("text:MISTER_MORPH_LOG_LEVEL=debug");
  await app.waitUntil(() => app.clipboard() === "MISTER_MORPH_LOG_LEVEL");
});
