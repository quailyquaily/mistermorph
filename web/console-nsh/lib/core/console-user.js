// The Console's human: the one person who uses this Console. Only the name they are addressed by
// can be set. The server keeps it (console.user_name, read with GET /auth/me) and puts it on each
// new task; nothing here is kept in the browser, so every client of a Console shows the same name.
import { reactiveRecord } from "../stores/reactive-record.js";
import { apiFetch } from "./context";
import { CONSOLE_USER_NAME_KEY, CONSOLE_USER_NAME_MAX, normalizeConsoleUserName } from "./console-user-name.js";

export { CONSOLE_USER_NAME_KEY, CONSOLE_USER_NAME_MAX, normalizeConsoleUserName };


// `known`: the server said whether a name is saved. A server from before names could be saved
// says nothing, and then there is no name to ask for.
const consoleUser = reactiveRecord({ known: false, name: "" });

/** Takes the name from an answer of GET /auth/me. */
export function applyConsoleUserFromMe(me) {
  if (typeof me?.user_name !== "string") {
    consoleUser.known = false;
    consoleUser.name = "";
    return;
  }
  const saved = normalizeConsoleUserName(me.user_name);
  consoleUser.known = true;
  consoleUser.name = saved.error ? "" : saved.name;
}

/** Forgets the name (the session ended). */
export function clearConsoleUser() {
  consoleUser.known = false;
  consoleUser.name = "";
}

/** Whether this Console's server keeps a name for its user. Tracked where it is read. */
export function consoleUserNameSupported() {
  return consoleUser.known === true;
}

/** The saved name, or "" when none is saved. Tracked where it is read. */
export function consoleUserName() {
  return consoleUser.known ? consoleUser.name : "";
}

/** Whether Setup still has the name to ask for: the server keeps one and none is saved. */
export function consoleUserNameMissing() {
  return consoleUser.known === true && consoleUser.name === "";
}

/** The name to show for the Console's user: the saved one, else `fallback`. */
export function consoleUserLabel(fallback) {
  return consoleUserName() || String(fallback || "");
}

/** Reads the saved name from the server again; "" when none is saved or the server keeps none. */
export async function loadConsoleUserName() {
  applyConsoleUserFromMe(await apiFetch("/auth/me"));
  return consoleUserName();
}

/**
 * Saves the name: that one config key and nothing else. Resolves with the name the server saved,
 * once it has; rejects (and keeps the name that was saved before) when the server does not.
 * @param {unknown} raw
 */
export async function saveConsoleUserName(raw) {
  const next = normalizeConsoleUserName(raw);
  if (next.error) {
    throw new Error(`invalid console user name: ${next.error}`);
  }
  const data = await apiFetch("/settings/console", {
    method: "PUT",
    body: { config_changes: { [CONSOLE_USER_NAME_KEY]: next.name } },
  });
  const saved = normalizeConsoleUserName(data?.config_values?.[CONSOLE_USER_NAME_KEY]);
  if (saved.error) {
    throw new Error("the server did not confirm the saved name");
  }
  consoleUser.known = true;
  consoleUser.name = saved.name;
  return saved.name;
}
