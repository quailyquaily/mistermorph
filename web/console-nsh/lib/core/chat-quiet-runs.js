import { isCronTopicID } from "./chat-cron-topics.js";

// A TODO item's scheduled run that found nothing to do (result.outcome "nothing", set by the
// runtime's check after the run) is a quiet run. In the item's topic, consecutive quiet runs are
// drawn as one line that opens, instead of a full message pair each.

/** The role of the row that stands for a group of quiet runs. */
export const QUIET_RUNS_ROLE = "quiet-runs";

const QUIET_OUTCOME = "nothing";
// A row shows one line; a longer reply is cut here before the row cuts it to its width.
const ONE_LINE_LIMIT = 240;

function text(value) {
  return String(value || "").trim();
}

function taskIDOf(item, suffix) {
  const id = text(item?.id);
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : "";
}

// Whether the reply is a quiet run's: a finished run of a TODO item that the check marked
// "nothing". A run in progress, a failed or stopped one, a manual one and one from before the
// check have no such mark, and are shown in full.
export function isQuietRunItem(item) {
  return (
    text(item?.role).toLowerCase() === "agent" &&
    text(item?.status).toLowerCase() === "done" &&
    text(item?.outcome) === QUIET_OUTCOME &&
    text(item?.taskId) !== "" &&
    isCronTopicID(text(item?.topicID))
  );
}

// A reply as one line: its line breaks and runs of white space become single spaces.
export function quietRunLine(raw) {
  const line = String(raw || "").replace(/\s+/gu, " ").trim();
  return line.length > ONE_LINE_LIMIT ? `${line.slice(0, ONE_LINE_LIMIT).trimEnd()}…` : line;
}

// The key of the page's fold state for a group (true = open) and for one of its runs (true =
// shown in full). A group is named by its first run, which stays the same as new runs join it.
export function quietGroupFoldKey(groupID) {
  return text(groupID);
}

export function quietRunFoldKey(taskID) {
  return `quiet-run:${text(taskID)}`;
}

// foldQuietRuns replaces each run of consecutive quiet runs in a conversation's items with one
// group row: { id: "quiet:<first task id>", role: "quiet-runs", runs, fromText, toText }. Each run
// keeps its two items (the task's message and the reply), so it can be shown in full in place.
// Any other item ends the group and stays as it is; one quiet run is a group too. It returns the
// same array when there is nothing to fold.
export function foldQuietRuns(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.some(isQuietRunItem)) {
    return list;
  }
  const out = [];
  let group = null;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    let user = null;
    let agent = null;
    const next = list[index + 1];
    const userTaskID = text(item?.role).toLowerCase() === "user" && !text(item?.steerTargetTaskID) ? taskIDOf(item, ":user") : "";
    if (userTaskID && isQuietRunItem(next) && text(next.taskId) === userTaskID) {
      user = item;
      agent = next;
      index += 1;
    } else if (isQuietRunItem(item)) {
      agent = item;
    }
    if (!agent) {
      group = null;
      out.push(item);
      continue;
    }
    const taskID = text(agent.taskId);
    if (!group) {
      group = { id: `quiet:${taskID}`, role: QUIET_RUNS_ROLE, text: "", topicID: text(agent.topicID), runs: [], fromText: "", toText: "" };
      out.push(group);
    }
    group.runs.push({
      id: taskID,
      // When the run started: the time on its task message.
      at: text(user?.timeText) || text(agent.timeText),
      text: quietRunLine(agent.text),
      user,
      agent,
    });
    group.fromText = group.runs[0].at;
    group.toText = group.runs[group.runs.length - 1].at;
  }
  return out;
}

// The time span a group's line shows: "09:00 – 12:30", or one time when the runs share it.
export function quietRunsSpan(group) {
  const from = text(group?.fromText);
  const to = text(group?.toText);
  if (!from || !to || from === to) {
    return from || to;
  }
  return `${from} – ${to}`;
}
