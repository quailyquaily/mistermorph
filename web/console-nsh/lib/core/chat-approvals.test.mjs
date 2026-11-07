import assert from "node:assert/strict";
import test from "node:test";

import { approvalDetailsByID, approvalParameterEntries, skillInstallApproval, taskApprovalState } from "./chat-approvals.js";

test("approvalDetailsByID preserves complete tool parameters", () => {
  const command = "printf 'approval details'; ".repeat(24);
  const details = approvalDetailsByID({
    items: [
      {
        approval_request_id: "apr_1",
        status: "denied",
        tool_name: "bash",
        reasons: ["bash_requires_approval"],
        tool_params: {
          cmd: command,
          cwd: "/srv/morph",
          timeout_seconds: 180,
        },
      },
    ],
  });

  assert.deepEqual(details.get("apr_1"), {
    approvalRequestID: "apr_1",
    status: "denied",
    toolName: "bash",
    reasons: ["bash_requires_approval"],
    toolParams: {
      cmd: command,
      cwd: "/srv/morph",
      timeout_seconds: 180,
    },
    skillPreview: null,
  });
});

const skillPreview = {
  preview_id: "p1",
  name: "guizang-ppt-skill",
  description: "Single-file HTML decks.",
  source: { kind: "github", url: "https://github.com/op7418/guizang-ppt-skill/tree/c91369c449d3/", commit: "c91369c449d34755d320a8b81d0734000d99d1ab" },
  files: [{ path: "SKILL.md", size: 100 }, { path: "a.png", size: 900, kind: "image" }, { path: "ref.md", size: 10 }],
  total_bytes: 1000,
  review: { summary: "Makes decks.", capabilities: ["runs node scripts"] },
  findings: [
    { severity: "info", title: "Ships a script the agent may run", file: "run.mjs", source: "check" },
    { severity: "medium", title: "Pulls code from a remote repository", file: "SKILL.md", line: 12, evidence: "git pull", rationale: "Later code was not reviewed.", source: "check" },
    { severity: "high", title: "Sends the API key to a remote host", file: "run.mjs", evidence: "fetch(url, {body: key})", source: "review", evidence_verified: false },
  ],
  audit: [
    { path: "SKILL.md", kind: "instructions", status: "reviewed" },
    { path: "a.png", kind: "image", status: "inspected", note: "PNG 4x4" },
    { path: "ref.md", kind: "text", status: "not_reviewed" },
  ],
  assessment: { complete: false, incomplete_reasons: ["1 text files were not read by the model review"], level: "high", score: 35, rubric: "rubric" },
};
const skillParams = { preview_id: "p1", name: "guizang-ppt-skill", source: skillPreview.source.url, commit: skillPreview.source.commit };

test("skillInstallApproval puts the assessment and coverage first, then issues by severity, notes apart", () => {
  const [detail] = approvalDetailsByID({ items: [{ approval_request_id: "a", tool_name: "skill_install", tool_params: skillParams, skill_preview: skillPreview }] }).values();
  const card = skillInstallApproval(detail);
  assert.equal(card.canApprove, true);
  assert.equal(card.commit, "c91369c449d3");
  const pinnedURL = { ...skillPreview, source: { ...skillPreview.source, url: "https://github.com/o/r/tree/" + skillPreview.source.commit } };
  assert.equal(skillInstallApproval({ toolName: "skill_install", toolParams: { ...skillParams, source: pinnedURL.source.url }, skillPreview: pinnedURL }).commit, "");

  assert.deepEqual(card.assessment, { complete: false, level: "high", score: 35, rubric: "rubric", incompleteReasons: skillPreview.assessment.incomplete_reasons });
  assert.equal(card.coverage.files, 3);
  assert.equal(card.coverage.reviewed, 1);
  assert.equal(card.coverage.inspected, 1);
  assert.deepEqual(card.coverage.gaps.map((g) => g.path), ["ref.md"]);

  assert.deepEqual(card.issues.map((f) => f.severity), ["high", "medium"]);
  assert.equal(card.issues[0].evidenceVerified, false);
  assert.equal(card.issues[0].source, "review");
  assert.equal(card.issues[1].line, 12);
  assert.deepEqual(card.notes.map((f) => f.title), ["Ships a script the agent may run"]);
});

test("skillInstallApproval never shows an unclear assessment as complete", () => {
  const card = (assessment, extra = {}) =>
    skillInstallApproval({ toolName: "skill_install", toolParams: skillParams, skillPreview: { ...skillPreview, ...extra, assessment } }).assessment;
  assert.equal(card({ complete: true, level: "none", score: 0 }).complete, true);
  assert.equal(card(undefined).complete, false);
  assert.equal(card({ level: "none" }).complete, false);
  assert.equal(card({ complete: true, level: "none" }, { review_error: "model timed out" }).complete, false);
  assert.equal(card({ complete: true, level: "bogus" }).level, "none");
});

test("skillInstallApproval blocks Approve when it would fail", () => {
  assert.equal(skillInstallApproval({ toolName: "bash", toolParams: {} }), null);
  assert.deepEqual(skillInstallApproval({ toolName: "skill_install", toolParams: skillParams, skillPreview: null }), { expired: true, canApprove: false });
  const mismatch = skillInstallApproval({ toolName: "skill_install", toolParams: { ...skillParams, commit: "other" }, skillPreview });
  assert.equal(mismatch.canApprove, false);
  const conflict = { ...skillPreview, conflict: { dir: "/skills/guizang-ppt-skill" } };
  assert.equal(skillInstallApproval({ toolName: "skill_install", toolParams: skillParams, skillPreview: conflict }).canApprove, false);
  assert.equal(skillInstallApproval({ toolName: "skill_install", toolParams: { ...skillParams, replace: true }, skillPreview: conflict }).canApprove, true);
});

test("taskApprovalState keeps denied and expired approvals attached to terminal tasks", () => {
  assert.deepEqual(
    taskApprovalState({
      status: "canceled",
      approval_request_id: "apr_denied",
      error: "Approval denied. Task canceled.",
    }),
    {
      approvalRequestID: "apr_denied",
      message: "Approval denied. Task canceled.",
      status: "denied",
    }
  );
  assert.deepEqual(
    taskApprovalState({
      status: "canceled",
      approval_request_id: "apr_expired",
      error: "Approval expired. Task canceled.",
    }),
    {
      approvalRequestID: "apr_expired",
      message: "Approval expired. Task canceled.",
      status: "expired",
    }
  );
});

test("approvalParameterEntries keeps command first and formats all values", () => {
  assert.deepEqual(
    approvalParameterEntries({
      cwd: "/srv/morph",
      run_in_subtask: true,
      cmd: "echo one\necho two",
    }),
    [
      { name: "cmd", value: "echo one\necho two", command: true, multiline: true },
      { name: "cwd", value: "/srv/morph", command: false, multiline: false },
      { name: "run_in_subtask", value: "true", command: false, multiline: false },
    ]
  );
});
