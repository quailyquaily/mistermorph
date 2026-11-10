// The task a history item belongs to: a user item from the server is named after its task, one
// sent from this device carries it.
function itemTaskID(item) {
  const taskID = String(item?.taskId || "").trim();
  if (taskID) return taskID;
  const id = String(item?.id || "").trim();
  return id.endsWith(":user") ? id.slice(0, -":user".length) : "";
}

// Each message steered into a running task is followed by its own reply, then by the task's
// answer, which moves below the latest steered message.
function placeSteeredAgentsAfterUsers(items) {
  const ordered = Array.isArray(items) ? [...items] : [];
  const steers = ordered
    .filter((item) => String(item?.role || "") === "user")
    .map((item) => ({
      userID: String(item?.id || "").trim(),
      taskID: itemTaskID(item),
      targetTaskID: String(item?.steerTargetTaskID || "").trim(),
    }))
    .filter((steer) => steer.userID && steer.targetTaskID);

  for (const steer of steers) {
    const agentIndex = ordered.findIndex(
      (item) =>
        String(item?.role || "") === "agent" &&
        String(item?.taskId || "").trim() === steer.targetTaskID
    );
    if (agentIndex < 0) {
      continue;
    }
    const [agentItem] = ordered.splice(agentIndex, 1);
    const userIndex = ordered.findIndex((item) => String(item?.id || "").trim() === steer.userID);
    if (userIndex < 0) {
      ordered.splice(Math.min(agentIndex, ordered.length), 0, agentItem);
      continue;
    }
    let anchor = userIndex;
    const reply = ordered[userIndex + 1];
    if (steer.taskID && String(reply?.role || "") === "agent" && String(reply?.taskId || "").trim() === steer.taskID) {
      anchor = userIndex + 1;
    }
    ordered.splice(anchor + 1, 0, agentItem);
  }
  return ordered;
}

export { placeSteeredAgentsAfterUsers };
