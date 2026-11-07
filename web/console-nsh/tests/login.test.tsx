import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

test("without a password the console logs in by itself and opens the agent's chat", async () => {
  const { app, calls } = await openConsole({ location: "/" });
  await app.waitUntil(() => calls.some((call) => call.path === "/auth/me"));
  expect(calls.some((call) => call.path === "/auth/login")).toBe(true);
  await app.waitFor("id:nav-chat"); // the workspace sidebar
});

test("a wrong password says so, and the right one goes on to the page asked for", async () => {
  const { app } = await openConsole({ location: "/e/default/todo", password: true });
  await app.waitFor("id:login-password");
  await app.press("role:button[Login]");
  await app.waitFor("Please enter password");
  await app.type("id:login-password", "nope");
  await app.press("role:button[Login]");
  await app.waitFor("invalid password");
  await app.clear("id:login-password");
  await app.type("id:login-password", "secret");
  await app.press("role:button[Login]");
  await app.waitFor("id:nav-todo");
});
