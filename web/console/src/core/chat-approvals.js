function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textList(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function approvalDetailsByID(payload) {
  const details = new Map();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const raw of items) {
    const approvalRequestID = String(raw?.approval_request_id || "").trim();
    if (!approvalRequestID) {
      continue;
    }
    const params = raw?.tool_params;
    details.set(approvalRequestID, {
      approvalRequestID,
      status: String(raw?.status || "").trim().toLowerCase(),
      toolName: String(raw?.tool_name || "").trim(),
      reasons: Array.isArray(raw?.reasons)
        ? raw.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
        : [],
      toolParams: params && typeof params === "object" && !Array.isArray(params) ? params : null,
      skillPreview: isPlainObject(raw?.skill_preview) ? raw.skill_preview : null,
    });
  }
  return details;
}

function taskApprovalState(task) {
  const taskStatus = String(task?.status || "").trim().toLowerCase();
  const output = task?.result?.final?.output;
  const approvalRequestID = String(task?.approval_request_id || output?.approval_request_id || "").trim();
  if (!approvalRequestID) {
    return null;
  }
  if (taskStatus === "pending") {
    return {
      approvalRequestID,
      message: String(output?.message || "").trim(),
      status: "pending",
    };
  }
  if (taskStatus !== "canceled") {
    return null;
  }
  const message = String(task?.error || "").trim();
  if (message === "Approval denied. Task canceled.") {
    return { approvalRequestID, message, status: "denied" };
  }
  if (message === "Approval expired. Task canceled.") {
    return { approvalRequestID, message, status: "expired" };
  }
  return null;
}

function approvalParameterEntries(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  return Object.entries(params)
    .sort(([left], [right]) => Number(right === "cmd") - Number(left === "cmd"))
    .map(([name, rawValue]) => {
      let value = rawValue;
      if (typeof value !== "string") {
        try {
          value = JSON.stringify(value, null, 2);
        } catch {
          value = String(value);
        }
      }
      return {
        name,
        value: String(value ?? ""),
        command: name === "cmd",
        multiline: String(value ?? "").includes("\n"),
      };
    });
}

// What a skill_install approval card shows: the preview the call would install, with every risk,
// so the user decides on the card itself. Approve is what installs the skill. It returns null for
// other tools, and { expired: true } when the preview is gone (approving would fail).
function skillInstallApproval(approval) {
  if (String(approval?.toolName || "").trim().toLowerCase() !== "skill_install") {
    return null;
  }
  const preview = approval?.skillPreview;
  if (!isPlainObject(preview)) {
    return { expired: true, canApprove: false };
  }
  const params = isPlainObject(approval?.toolParams) ? approval.toolParams : {};
  const source = isPlainObject(preview.source) ? preview.source : {};
  const review = isPlainObject(preview.review) ? preview.review : null;
  const files = Array.isArray(preview.files) ? preview.files.filter(isPlainObject) : [];
  const commit = String(source.commit || "").trim();
  // skill_install refuses a call whose name, source or commit differ from its preview.
  const mismatch =
    String(params.name ?? "").trim() !== String(preview.name ?? "").trim() ||
    String(params.source ?? "").trim() !== String(source.url ?? "").trim() ||
    String(params.commit ?? "").trim() !== commit;
  const conflict = isPlainObject(preview.conflict) ? preview.conflict : null;
  return {
    expired: false,
    mismatch,
    // Also refused: a skill already installed under this id, unless the call replaces it.
    canApprove: !mismatch && !(conflict && params.replace !== true),
    name: String(preview.name || preview.skill_id || "").trim(),
    description: String(preview.description || "").trim(),
    sourceURL: String(source.url || "").trim(),
    // Shown beside the source only when the link does not already pin it.
    commit: commit && !String(source.url || "").includes(commit) ? commit.slice(0, 12) : "",
    fileCount: files.length,
    totalBytes: Number(preview.total_bytes) || files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
    requirements: textList(preview.requirements),
    authProfiles: textList(preview.auth_profiles),
    summary: String(review?.summary || "").trim(),
    capabilities: textList(review?.capabilities),
    // Every risk: the isolated review's, then the file checks'.
    risks: [...textList(review?.risks), ...textList(preview.risks)],
    reviewError: String(preview.review_error || "").trim(),
    replaces: conflict ? String(conflict.dir || "").trim() : "",
    replace: params.replace === true,
  };
}

export { approvalDetailsByID, approvalParameterEntries, skillInstallApproval, taskApprovalState };
