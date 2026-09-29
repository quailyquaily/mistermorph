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

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

function severityOf(value) {
  const s = String(value || "").trim().toLowerCase();
  return SEVERITY_ORDER.includes(s) ? s : "medium";
}

function normalizeFinding(raw, index) {
  const verified = raw?.evidence_verified;
  return {
    id: `${index}`,
    severity: severityOf(raw?.severity),
    category: String(raw?.category || "").trim(),
    title: String(raw?.title || "").trim(),
    file: String(raw?.file || "").trim(),
    line: Number(raw?.line) > 0 ? Number(raw.line) : 0,
    evidence: String(raw?.evidence || "").trim(),
    rationale: String(raw?.rationale || "").trim(),
    source: raw?.source === "review" ? "review" : "check",
    evidenceVerified: typeof verified === "boolean" ? verified : null,
  };
}

// Audit statuses that mean a file was examined in full.
const FULLY_EXAMINED = new Set(["reviewed", "inspected"]);

// What a skill_install approval card shows: the preview the call would install, with the overall
// assessment and audit coverage first, then findings by severity, so the user decides on the card.
// Approve is what installs the skill. It returns null for other tools, and { expired: true } when
// the preview is gone (approving would fail).
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

  const findings = (Array.isArray(preview.findings) ? preview.findings : [])
    .filter(isPlainObject)
    .map(normalizeFinding)
    .filter((f) => f.title)
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const rawAssessment = isPlainObject(preview.assessment) ? preview.assessment : {};
  const audit = (Array.isArray(preview.audit) ? preview.audit : []).filter(isPlainObject).map((raw) => ({
    path: String(raw.path || "").trim(),
    kind: String(raw.kind || "").trim(),
    status: String(raw.status || "").trim(),
    note: String(raw.note || "").trim(),
  }));
  const coverage = {};
  for (const item of audit) {
    coverage[item.status] = (coverage[item.status] || 0) + 1;
  }
  const reviewError = String(preview.review_error || "").trim();
  const incompleteReasons = textList(rawAssessment.incomplete_reasons);
  // An assessment that does not say it is complete is treated as incomplete.
  const complete = rawAssessment.complete === true && incompleteReasons.length === 0 && !reviewError;
  const level = ["none", ...SEVERITY_ORDER].includes(rawAssessment.level) ? rawAssessment.level : "none";

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
    reviewError,
    assessment: {
      complete,
      level,
      score: Math.max(0, Math.min(100, Number(rawAssessment.score) || 0)),
      rubric: String(rawAssessment.rubric || "").trim(),
      incompleteReasons,
    },
    coverage: {
      files: audit.length || files.length,
      reviewed: coverage.reviewed || 0,
      inspected: coverage.inspected || 0,
      partlyReviewed: coverage.partly_reviewed || 0,
      notReviewed: coverage.not_reviewed || 0,
      reviewFailed: coverage.review_failed || 0,
      notInspected: coverage.not_inspected || 0,
      // Files not examined in full, for the expandable list.
      gaps: audit.filter((item) => !FULLY_EXAMINED.has(item.status)),
    },
    // Issues first (most severe first); info findings are notes, not risks.
    issues: findings.filter((f) => f.severity !== "info"),
    notes: findings.filter((f) => f.severity === "info"),
    replaces: conflict ? String(conflict.dir || "").trim() : "",
    replace: params.replace === true,
  };
}

export { approvalDetailsByID, approvalParameterEntries, skillInstallApproval, taskApprovalState };
