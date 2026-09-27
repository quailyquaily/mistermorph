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
  files: [{ path: "SKILL.md", size: 100 }, { path: "a.png", size: 900, kind: "image" }],
  total_bytes: 1000,
  risks: ["ships 1 image and font files, checked only by file type and not reviewed: a.png"],
  review: { summary: "Makes decks.", capabilities: ["runs node scripts"], risks: ["loads Google Fonts"] },
};
const skillParams = { preview_id: "p1", name: "guizang-ppt-skill", source: skillPreview.source.url, commit: skillPreview.source.commit };

test("skillInstallApproval shows the preview a skill_install would install, with every risk", () => {
  const [detail] = approvalDetailsByID({ items: [{ approval_request_id: "a", tool_name: "skill_install", tool_params: skillParams, skill_preview: skillPreview }] }).values();
  const card = skillInstallApproval(detail);
  assert.equal(card.canApprove, true);
  assert.equal(card.mismatch, false);
  assert.equal(card.commit, "c91369c449d3");
  const pinnedURL = { ...skillPreview, source: { ...skillPreview.source, url: "https://github.com/o/r/tree/" + skillPreview.source.commit } };
  assert.equal(skillInstallApproval({ toolName: "skill_install", toolParams: { ...skillParams, source: pinnedURL.source.url }, skillPreview: pinnedURL }).commit, "");
  assert.equal(card.fileCount, 2);
  assert.equal(card.totalBytes, 1000);
  // The review's risks first, then the file checks'.
  assert.deepEqual(card.risks, ["loads Google Fonts", skillPreview.risks[0]]);
  assert.deepEqual(card.capabilities, ["runs node scripts"]);
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
