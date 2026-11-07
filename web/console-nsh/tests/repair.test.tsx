// Troubleshooting: the issues that block startup and the actions that resolve each.
import { expect, test } from "nsh/test";
import type { ApiRequest } from "./harness";
import { openConsole } from "./harness";

function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}

const SECRET_ISSUE = {
  key: "config",
  code: "os_secret_not_found",
  name: "config.yaml",
  path: "/home/me/.morph/config.yaml",
  error: "keyring entry llm.api_key not found",
  stage: "llm",
  status: "malformed",
  field_path: ["llm", "api_key"],
};
const IDENTITY_ISSUE = {
  key: "identity",
  code: "identity_invalid",
  name: "identity.yaml",
  path: "/home/me/.morph/identity.yaml",
  error: "yaml: line 2: mapping values are not allowed here",
  stage: "persona",
  status: "malformed",
};

/** Integrity that answers `issues` until `fixed()` is true. */
function integrity(issues: unknown[], fixed: () => boolean) {
  return () => ({ body: { items: fixed() ? [] : issues } });
}

test("a blocking issue sends the console to troubleshooting, and a replaced secret clears it", async () => {
  let fixed = false;
  let saved: any = null;
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: {
      "GET /setup/integrity": integrity([SECRET_ISSUE], () => fixed),
      "PUT /setup/secret": (request: ApiRequest) => {
        saved = request.json;
        fixed = true;
        return { body: {} };
      },
    },
  });
  await app.waitFor("id:repair-page");
  expect(lastLocation(app).startsWith("/e/default/troubleshooting")).toBe(true);
  await app.waitFor("text:SECRET IS MISSING"); // the boxed section's caps title
  await app.waitFor("text:llm.api_key");
  await app.waitFor("text:keyring entry llm.api_key not found");
  // A missing secret offers no Retry and no Setup, only its own fixes and the source.
  expect(app.shows("role:button[Retry]")).toBe(false);
  expect(app.shows("role:button[Setup]")).toBe(false);
  expect(app.shows("role:button[Edit Source]")).toBe(true);

  await app.press("role:button[Replace Secret]");
  await app.waitFor("id:repair-secret-input");
  expect(app.enabled("id:repair-secret-save")).toBe(false);
  await app.type("id:repair-secret-input", "sk-new");
  await app.press("id:repair-secret-save");
  await app.waitUntil(() => saved !== null);
  expect(saved).toEqual({ field_path: ["llm", "api_key"], value: "sk-new" });
  // With nothing left it goes on to setup.
  await app.waitUntil(() => !lastLocation(app).includes("troubleshooting"));
});

test("removing a secret reference asks first, and a failure is reported", async () => {
  let removeCalls = 0;
  const { app } = await openConsole({
    location: "/e/default/troubleshooting",
    api: {
      "GET /setup/integrity": integrity([SECRET_ISSUE], () => false),
      "DELETE /setup/secret": () => {
        removeCalls += 1;
        return { status: 500, body: { error: "config is read-only" } };
      },
    },
  });
  await app.waitFor("text:SECRET IS MISSING"); // the boxed section's caps title
  await app.press("role:button[Remove Reference]");
  await app.waitFor("id:repair-remove-dialog");
  await app.waitFor("text:/Remove llm.api_key from config.yaml/");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:repair-remove-dialog", { state: "gone" });
  expect(removeCalls).toBe(0);

  await app.press("role:button[Remove Reference]");
  await app.press("id:dialog-action-remove");
  await app.waitFor("text:config is read-only");
  expect(removeCalls).toBe(1);
});

test("edit source loads the file, saves it, and setup opens the step to fix", async () => {
  let fixed = false;
  let savedContent = "";
  const { app, calls } = await openConsole({
    location: "/e/default/troubleshooting",
    api: {
      "GET /setup/integrity": integrity([IDENTITY_ISSUE], () => fixed),
      "GET /setup/file": { body: { name: "identity.yaml", path: "/home/me/.morph/identity.yaml", content: "name: [broken\n" } },
      "PUT /setup/file": (request: ApiRequest) => {
        savedContent = String(request.json?.content || "");
        return { status: 500, body: { error: "write failed" } };
      },
    },
  });
  await app.waitFor("text:IDENTITY FILE IS INVALID");
  await app.press("role:button[Edit Source]");
  await app.waitFor("id:raw-text-editor");
  await app.waitFor("text:Edit Source identity.yaml");
  expect(app.value("id:raw-text-body")).toBe("name: [broken\n");
  expect(calls.some((call) => call.path === "/setup/file" && call.query.get("key") === "identity")).toBe(true);
  await app.clear("id:raw-text-body");
  await app.type("id:raw-text-body", "name: Fixed");
  await app.press("id:raw-text-save");
  await app.waitFor("text:write failed");
  expect(savedContent).toBe("name: Fixed");
  // A failed save keeps the editor open.
  expect(app.shows("id:raw-text-editor")).toBe(true);
  await app.press("id:raw-text-editor >> label:Close");
  await app.waitFor("id:raw-text-editor", { state: "gone" });

  fixed = false;
  await app.press("role:button[Setup]");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/setup/persona?repair=identity"));
});

test("an integrity check that fails shows its error", async () => {
  const { app } = await openConsole({
    location: "/e/default/troubleshooting",
    api: { "GET /setup/integrity": { status: 500, body: { error: "integrity check crashed" } } },
  });
  await app.waitFor("id:repair-error >> text:integrity check crashed");
  expect(app.shows("id:repair-empty")).toBe(false);
});

test("an unreadable file offers Retry, which checks again", async () => {
  let checks = 0;
  const { app } = await openConsole({
    location: "/e/default/troubleshooting",
    api: {
      "GET /setup/integrity": () => {
        checks += 1;
        return {
          body: {
            items: [
              { key: "config", code: "file_unreadable", name: "config.yaml", path: "/x/config.yaml", error: "permission denied", stage: "llm", status: "unreadable" },
            ],
          },
        };
      },
    },
  });
  await app.waitFor("text:FILE CANNOT BE READ");
  expect(app.shows("role:button[Edit Source]")).toBe(false);
  const before = checks;
  await app.press("role:button[Retry]");
  await app.waitUntil(() => checks > before);
});
