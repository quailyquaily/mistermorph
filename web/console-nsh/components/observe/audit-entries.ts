// The Audit page's reading of guard audit lines and tasks (the Vue AuditView's helpers, unchanged
// in behaviour): labels for decisions, risks, reasons and approvals, the files' titles and order,
// and the badges' weights.
import { formatShortTime, formatTime, safeJSON, toBool } from "../../lib/core/context.js";
import { taskWaitingForAnswer } from "../../lib/core/chat-task-history.js";
import type { AuditBadgeSpec } from "./parts";
import { t } from "./parts";

export function normalizeAuditText(value: unknown, fallback = "-"): string {
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? fallback : s;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return fallback;
}

function normalizeAuditList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((it) => (typeof it === "string" ? it.trim() : it === null || it === undefined ? "" : String(it).trim()))
    .filter((it) => it !== "");
}

export function humanizeAuditToken(raw: unknown): string {
  const text = normalizeAuditText(raw, "");
  if (!text) return "-";
  return text.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

// Badge weight follows attention, not colour alone: routine states are quiet outlined grey,
// notable ones are outlined in their colour, and only states that need action are filled.
export function auditBadge(level: "alert" | "notable" | "quiet", type: AuditBadgeSpec["type"] = "default"): AuditBadgeSpec {
  if (level === "alert") return { type, variant: "filled" };
  if (level === "notable") return { type, variant: "outlined" };
  return { type: "default", variant: "outlined" };
}

function decisionBadge(raw: unknown) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "allow_with_redaction":
      return auditBadge("notable", "warning");
    case "require_approval":
      return auditBadge("alert", "warning");
    case "deny":
      return auditBadge("alert", "danger");
    default:
      return auditBadge("quiet");
  }
}

function approvalBadge(status: string) {
  switch (status) {
    case "pending":
      return auditBadge("alert", "warning");
    case "denied":
      return auditBadge("alert", "danger");
    default:
      return auditBadge("quiet");
  }
}

export type RiskType = "success" | "warning" | "danger" | "default";
function riskBadgeType(raw: unknown): RiskType {
  switch (String(raw || "").trim().toLowerCase()) {
    case "low":
      return "success";
    case "medium":
      return "warning";
    case "high":
    case "critical":
      return "danger";
    default:
      return "default";
  }
}

function decisionLabel(raw: unknown) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "allow":
      return t("audit_decision_allow");
    case "allow_with_redaction":
      return t("audit_decision_redact");
    case "require_approval":
      return t("audit_decision_require_approval");
    case "deny":
      return t("audit_decision_deny");
    default:
      return humanizeAuditToken(raw);
  }
}

function riskLabel(raw: unknown) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "low":
      return t("audit_risk_low");
    case "medium":
      return t("audit_risk_medium");
    case "high":
      return t("audit_risk_high");
    case "critical":
      return t("audit_risk_critical");
    default:
      return humanizeAuditToken(raw);
  }
}

const REASON_KEYS: Record<string, string> = {
  bash_requires_approval: "audit_reason_bash_requires_approval",
  url_fetch_not_allowlisted: "audit_reason_url_fetch_not_allowlisted",
  invalid_url: "audit_reason_invalid_url",
  private_ip: "audit_reason_private_ip",
  non_allowlisted_domain: "audit_reason_non_allowlisted_domain",
  sensitive_content_redacted: "audit_reason_sensitive_content_redacted",
  redacted_private_key_block: "audit_reason_redacted_private_key_block",
  redacted_jwt: "audit_reason_redacted_jwt",
  redacted_bearer_token: "audit_reason_redacted_bearer_token",
  redacted_mister_morph_env: "audit_reason_redacted_mister_morph_env",
  redacted_secret_value: "audit_reason_redacted_secret_value",
  redacted_custom_pattern: "audit_reason_redacted_custom_pattern",
};

function auditReasonLabel(raw: unknown) {
  const text = String(raw || "").trim().toLowerCase();
  if (REASON_KEYS[text]) return t(REASON_KEYS[text]);
  if (text.startsWith("redacted_custom_pattern_")) {
    return t("audit_reason_redacted_custom_pattern_named", {
      name: humanizeAuditToken(text.slice("redacted_custom_pattern_".length)),
    });
  }
  return humanizeAuditToken(raw);
}

function isOutputPublishSummaryPlaceholder(actionTypeRaw: unknown, summary: unknown) {
  return (
    String(actionTypeRaw || "").trim().toLowerCase() === "outputpublish" &&
    String(summary || "").trim() === "OutputPublish content=[redacted_summary]"
  );
}

function isBodyOmittedFromAudit(parsed: any, actionTypeRaw: unknown, summary: unknown) {
  return toBool(parsed?.body_omitted_from_audit, false) || isOutputPublishSummaryPlaceholder(actionTypeRaw, summary);
}

function auditFamilyTitle(name: unknown) {
  const value = String(name || "").trim();
  if (!value) return t("audit_stream_other");
  if (value.startsWith("guard_audit.allow_with_redaction.jsonl")) return t("audit_stream_allow_with_redaction");
  if (value.startsWith("guard_audit.require_approval.jsonl")) return t("audit_stream_require_approval");
  if (value.startsWith("guard_audit.deny.jsonl")) return t("audit_stream_deny");
  if (value.startsWith("guard_audit.jsonl")) return t("audit_stream_all");
  return t("audit_stream_other");
}

export function auditFamilyOrder(name: unknown) {
  const value = String(name || "").trim();
  if (value.startsWith("guard_audit.jsonl")) return 0;
  if (value.startsWith("guard_audit.require_approval.jsonl")) return 1;
  if (value.startsWith("guard_audit.allow_with_redaction.jsonl")) return 2;
  if (value.startsWith("guard_audit.deny.jsonl")) return 3;
  return 4;
}

export interface AuditFileItem {
  key: string;
  value: string;
  name: string;
  title: string;
  archived: boolean;
  subtitle: string;
}

export function toAuditFileItem(item: any): AuditFileItem {
  const name = String(item?.name || "").trim();
  const suffix = name.match(/\.jsonl\.(.+)$/)?.[1] || "";
  const timestamp = suffix.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const archivedAt = timestamp
    ? formatShortTime(`${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T${timestamp[4]}:${timestamp[5]}:${timestamp[6]}Z`)
    : suffix;
  return {
    key: name,
    value: name,
    name,
    title: auditFamilyOrder(name) === 4 ? name : auditFamilyTitle(name),
    archived: Boolean(suffix),
    subtitle: archivedAt ? t("audit_archived_at", { value: archivedAt }) : "",
  };
}

export function sortAuditFiles(files: unknown[]): AuditFileItem[] {
  return files
    .map((item) => toAuditFileItem(item))
    .filter((item) => item.value !== "")
    .sort(
      (left, right) =>
        Number(left.archived) - Number(right.archived) ||
        auditFamilyOrder(left.name) - auditFamilyOrder(right.name) ||
        right.name.localeCompare(left.name),
    );
}

export interface AuditEntry {
  key: string;
  parsed: boolean;
  raw: string;
  rawPretty: string;
  eventID: string;
  tsRaw: string;
  tsText: string;
  tsFull: string;
  actionType: string;
  toolName: string;
  runID: string;
  stepText: string;
  actor: string;
  approvalLabel: string;
  approvalBadge: AuditBadgeSpec;
  approvalRequestID: string;
  summary: string;
  reasonsText: string;
  hasReasons: boolean;
  primaryTitle: string;
  decisionLabel: string;
  decisionBadge: AuditBadgeSpec;
  riskLabel: string;
  riskType: RiskType;
}

const ACTION_LABELS: Record<string, string> = {
  ToolCallPre: "audit_action_tool_pre",
  ToolCallPost: "audit_action_tool_post",
  OutputPublish: "audit_action_output",
  SkillInstall: "audit_action_skill",
};

export function parseAuditLine(line: unknown): AuditEntry {
  const raw = typeof line === "string" ? line : String(line ?? "");
  const parsed = safeJSON(raw, null) as any;
  const quiet = auditBadge("quiet");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      key: raw,
      parsed: false,
      raw,
      rawPretty: raw,
      eventID: "-",
      tsRaw: "-",
      tsText: "-",
      tsFull: "",
      actionType: "-",
      toolName: "-",
      runID: "-",
      stepText: "-",
      actor: "-",
      approvalLabel: "-",
      approvalBadge: quiet,
      approvalRequestID: "-",
      summary: "-",
      reasonsText: "-",
      hasReasons: false,
      primaryTitle: t("audit_raw"),
      decisionLabel: "-",
      decisionBadge: quiet,
      riskLabel: "-",
      riskType: "default",
    };
  }
  const eventID = normalizeAuditText(parsed.event_id);
  const tsRaw = normalizeAuditText(parsed.ts);
  const stepText = Number(parsed.step) < 0 ? "-" : normalizeAuditText(parsed.step);
  const actionTypeRaw = normalizeAuditText(parsed.action_type);
  const actionType = ACTION_LABELS[actionTypeRaw] ? t(ACTION_LABELS[actionTypeRaw]) : humanizeAuditToken(actionTypeRaw);
  const toolName = normalizeAuditText(parsed.tool_name);
  const runID = normalizeAuditText(parsed.run_id);
  const actor = normalizeAuditText(parsed.actor);
  const approvalStatus = normalizeAuditText(parsed.approval_status);
  const summaryRaw = normalizeAuditText(parsed.action_summary_redacted);
  const reasons = normalizeAuditList(parsed.reasons);
  const decisionRaw = normalizeAuditText(parsed.decision, "");
  const riskRaw = normalizeAuditText(parsed.risk_level, "");
  const bodyOmitted = isBodyOmittedFromAudit(parsed, actionTypeRaw, summaryRaw);
  const summary = isOutputPublishSummaryPlaceholder(actionTypeRaw, summaryRaw) ? t("audit_output_publish_summary") : summaryRaw;
  let reasonsText = reasons.length > 0 ? reasons.map((reason) => auditReasonLabel(reason)).join(" | ") : "-";
  if (bodyOmitted && reasonsText === "-") reasonsText = t("audit_output_publish_reason");
  const approval = approvalStatus.toLowerCase();
  const knownApproval = ["pending", "approved", "denied", "expired"].includes(approval);
  return {
    key: raw,
    parsed: true,
    raw,
    rawPretty: JSON.stringify(parsed, null, 2),
    eventID,
    tsRaw,
    tsText: tsRaw === "-" ? "-" : formatShortTime(tsRaw),
    tsFull: tsRaw === "-" ? "" : formatTime(tsRaw),
    actionType,
    toolName,
    runID,
    stepText,
    actor,
    approvalLabel: knownApproval ? t(`audit_approval_${approval}`) : humanizeAuditToken(approvalStatus),
    approvalBadge: approvalBadge(approval),
    approvalRequestID: normalizeAuditText(parsed.approval_request_id),
    summary,
    reasonsText,
    hasReasons: reasons.length > 0,
    primaryTitle: toolName !== "-" ? toolName : actionType,
    decisionLabel: decisionLabel(decisionRaw),
    decisionBadge: decisionBadge(decisionRaw),
    riskLabel: riskLabel(riskRaw),
    riskType: riskBadgeType(riskRaw),
  };
}

/** The page's lines as entries, newest first, each with a key unique on the page. */
export function auditEntries(lines: unknown[]): AuditEntry[] {
  const occurrences = new Map<string, number>();
  return lines
    .map((line) => {
      const item = parseAuditLine(line);
      const count = occurrences.get(item.key) || 0;
      occurrences.set(item.key, count + 1);
      item.key = `${item.key}:${count}`;
      return item;
    })
    .reverse();
}

export function filterAuditEntries(items: AuditEntry[], filter: string): AuditEntry[] {
  const query = filter.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) =>
    [item.raw, item.summary, item.reasonsText, item.decisionLabel, item.riskLabel, item.approvalLabel].join(" ").toLowerCase().includes(query),
  );
}

export interface AuditGroup {
  key: string;
  runID: string;
  title: string;
  items: AuditEntry[];
}

export function groupAuditEntries(items: AuditEntry[]): AuditGroup[] {
  const groups: AuditGroup[] = [];
  const byRunID = new Map<string, AuditGroup>();
  for (const item of items) {
    const runID = item.parsed ? item.runID : "-";
    const key = `run:${runID}`;
    let group = byRunID.get(key);
    if (!group) {
      group = { key, runID, title: runID === "-" ? t("audit_run_unknown") : runID, items: [] };
      byRunID.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/* ---------- tasks ---------- */

function taskTextPreview(task: any) {
  const text = String(task?.task || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
}

function shortenTaskID(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return "-";
  return value.length <= 18 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export function taskTitle(task: any) {
  return taskTextPreview(task) || String(task?.task || "").trim() || shortenTaskID(task?.id);
}

export function taskStatusBadge(task: any): AuditBadgeSpec {
  // A running task waiting for the person's answer to its question is marked as one waiting for them.
  if (taskWaitingForAnswer(task)) return auditBadge("alert", "warning");
  switch (String(task?.status || "").trim().toLowerCase()) {
    case "failed":
      return auditBadge("alert", "danger");
    case "pending":
      return auditBadge("alert", "warning");
    case "running":
      return auditBadge("notable", "success");
    default:
      return auditBadge("quiet");
  }
}

export function taskModelMeta(task: any) {
  return String(task?.model || "").trim() || "default";
}
