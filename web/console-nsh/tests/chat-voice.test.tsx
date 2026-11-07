// Voice input on nsh's Speech module: the mic listens, the live words show while it does, and the
// final text goes into the draft; discarding throws it away.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Voice", created_at: NOW, updated_at: NOW }] } };

// Needs `"speech": true` in nsh.json's capabilities (the integrator adds it); until then the
// platform refuses the session, which the next test covers.
test("speaking fills the draft, and discarding keeps it as it was", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:chat-composer-voice");
  await app.press("id:chat-composer-voice");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.hear("book a table");
  await app.waitFor("book a table");
  // Stopping ends the session with the words heard as its final text.
  await app.press("id:chat-composer-voice");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "book a table");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  // A discarded recording leaves the draft alone.
  await app.press("id:chat-composer-voice");
  await app.hear("never mind");
  await app.press("label:Discard recording");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  expect(app.value("id:chat-composer-input")).toBe("book a table");
});
