import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("Chat uses endpoint-scoped task streams", async () => {
  const context = await source("./context.js");
  const chat = await source("../views/ChatView.js");

  assert.match(context, /function supportsConsoleTaskStream\(endpointRef\)/u);
  assert.match(context, /String\(endpoint\?\.mode \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "console"/u);
  assert.match(context, /function buildConsoleStreamURL\(ticket, taskID, endpointRef = ""\)/u);
  assert.match(context, /query\.set\("endpoint", streamEndpointRef\)/u);

  assert.match(chat, /supportsConsoleTaskStream\(endpointRef\)/u);
  assert.match(chat, /buildConsoleStreamURL\(ticket, key, endpointRef\)/u);
  assert.equal(chat.includes("supportsConsoleLocalStream"), false);
});
