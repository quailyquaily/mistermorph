// Editing a message the person sent in a topic (FT140): which messages can be edited, and what the
// conversation keeps of itself once an edit is sent. The runtime does the replacing
// (POST /tasks/{id}/replace); the chat shows the same thing until the next load confirms it.
//
// A message can be edited when it has text, came from a task (so the runtime can find it) and is
// not a command: commands act on the runtime, not on the conversation, and the runtime refuses to
// edit them. `/think` asks for a harder think about a message, so it is a message.

function text(value) {
  return String(value ?? "").trim();
}

/** The task a history row belongs to: its taskId, or the `<task>:user` / `<task>:agent` id a loaded row has. */
export function historyItemTaskID(item) {
  const taskID = text(item?.taskId);
  if (taskID) return taskID;
  const role = text(item?.role);
  const id = text(item?.id);
  return role && id.endsWith(`:${role}`) ? id.slice(0, -(role.length + 1)) : "";
}

/** Whether text is a runtime command (`/reset`, `/model …`) rather than a message. */
export function isCommandMessage(value) {
  const word = text(value).split(/\s/, 1)[0] || "";
  if (!word.startsWith("/")) return false;
  const command = word.split("@", 1)[0].toLowerCase();
  return command !== "/" && command !== "/think";
}

/** Whether a history row is a sent message that can be edited. */
export function editableMessage(item) {
  return text(item?.role).toLowerCase() === "user" && historyItemTaskID(item) !== "" && text(item?.text) !== "" && !isCommandMessage(item?.text);
}

/** The index of the edited message's row: by its row id, else by its task (a reload may rename rows). */
export function editedMessageIndex(items, edit) {
  const list = Array.isArray(items) ? items : [];
  const byID = list.findIndex((item) => item?.id === edit?.itemID);
  if (byID >= 0) return byID;
  return list.findIndex((item) => text(item?.role).toLowerCase() === "user" && historyItemTaskID(item) === text(edit?.taskID));
}

/** The rows an edit replaces: the edited message's and every one after it (their ids). */
export function editReplacedItemIDs(items, edit) {
  const list = Array.isArray(items) ? items : [];
  const index = edit ? editedMessageIndex(list, edit) : -1;
  return new Set(index < 0 ? [] : list.slice(index).map((item) => item?.id));
}

/** The conversation an accepted edit leaves on screen: the rows before the edited message, or null when it is not there. */
export function historyBeforeEdit(items, edit) {
  const list = Array.isArray(items) ? items : [];
  const index = editedMessageIndex(list, edit);
  return index < 0 ? null : list.slice(0, index);
}

/** The quote bar's one line: the message with its line breaks and runs of spaces as single spaces. */
export function editQuoteLine(value) {
  return text(value).replace(/\s+/g, " ");
}
