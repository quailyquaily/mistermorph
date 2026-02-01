---
status: draft
---

# Guard Module (Prompt Injection Defense) — Requirements

Date: 2026-02-01

## 1. Background
Agents that (1) ingest untrusted content, (2) hold tool privileges, and (3) can access local/cloud resources are vulnerable to prompt injection, which can lead to:
- Sensitive information leakage (API keys, private memory, config files, system/host data, internal docs, etc.).
- Execution of dangerous operations (destructive commands, data exfiltration, privilege overreach, etc.).

This calls for a dedicated Guard module that provides consistent risk control across input, reasoning, tools, skills, and output, with human approval for high-risk actions.

## 2. Goals and Non-Goals

### 2.1 Goals
- Reduce the probability of sensitive data leakage and unsafe actions in prompt injection scenarios (secure-by-default).
- Enforce a consistent “block / downgrade / require approval” policy for risky actions, with full traceability (audits, event IDs, decision reasons).
- Provide a human-approval loop. MVP supports approvals via interactive TTY prompt and Telegram DM.
- Keep policies configurable and extensible (additional approval channels and detectors later).

### 2.2 Non-Goals (for MVP)
- Not aiming for perfect detection accuracy; prioritize explainable, configurable, auditable controls.
- No model training/fine-tuning as part of MVP; start with rules/heuristics + pluggable detectors.
- Not replacing the product’s authorization model; Guard is a safety gate, not a full permission system.

## 3. Threat Model (Scope)

### 3.1 Attack Surfaces
- External content: web pages, PDFs, emails, chat logs, issue/PR comments, logs, user-pasted text, etc.
- Tool outputs: shell output, file contents, HTTP responses, DB query results, etc.
- Multi-turn context: malicious instructions hidden inside history or disguised as “system prompts”.
- Skills: untrusted skill content and scripts, especially when installed from remote sources.

### 3.2 Protected Assets (Examples)
- Secrets: API keys, tokens, private keys, certificates, passwords, cookies/sessions, kubeconfig, SSH configs, etc.
- Private memory: user profiles, internal notes, private vector-store chunks, system prompts, internal tool docs, etc.
- Environment/system data: hostnames, internal IPs, process info, directory layouts, cloud account IDs, CI/CD variables, etc.
- Business data: customer data, orders/finance, internal code, unpublished documents, etc.

### 3.3 High-Risk Actions (Examples)
- Destructive operations: `rm -rf`, formatting disks, dropping DBs, overwriting critical files.
- Data exfiltration: sending file/log/config contents to external HTTP APIs, pasting into third-party services, uploading to unknown destinations.
- Privilege escalation / lateral movement: reading credential directories, scanning internal networks, downloading and executing unknown binaries.

## 4. Functional Requirements

### 4.1 Unified Interception Points (MUST)
Guard must provide consistent interception (middleware/hook style) at the following points:
- Tool call pre-hook (pre-call): inspect “what is about to be executed/sent/read”.
- Tool call post-hook (post-call): inspect “what the tool returned” (secrets, over-privileged data).
- Output pre-hook (pre-output): prevent leaking secrets in final responses or outbound messages.
- Memory read/retrieval pre/post (SHOULD): prevent prompt injection from triggering private memory access and exfiltration.
- Skill run pre-hook and post-hook (MUST): inspect the skill’s inputs/outputs and any tool calls the skill triggers.
- Skill install gate (MUST):
  - After download but before installing, scan the downloaded skill payload for potentially malicious behavior.
  - If the scan flags risk, block or require approval before writing any content into the skills directory.

### 4.2 Risk Levels and Actions (MUST)
Every guarded event must produce:
- Risk level: `low / medium / high / critical` (configurable thresholds).
- Action: `allow / allow_with_redaction / require_approval / deny`.
- Explainable reasons: matched rules, detector signals, and the triggering source (which input/tool/skill).

Default posture should be conservative: when uncertain, prefer `require_approval` or `deny` depending on context (fail closed for high-impact actions).

### 4.3 Sensitive Data Detection and Redaction (MUST)
- Detect sensitive patterns (rule-based first, with configurable regexes), e.g.:
  - Common key/token formats (OpenAI/Stripe/GitHub/AWS), JWTs, private key blocks, kubeconfigs, `.env` variables.
  - Path/file patterns: `~/.ssh/*`, `/etc/*`, `*.pem`, `*.key`, etc.
- Redaction strategies:
  - Output redaction: redact secrets before sending to the user (e.g., preserve only prefix/suffix).
  - Tool-output redaction: filter tool output before it is stored, used for reasoning, or displayed.
- Keep only a minimal “pre-redaction preview” for approvals and auditing, strictly limited in scope.

### 4.4 Dangerous Operation Detection (MUST)
At minimum cover shell, filesystem, and network:
- Shell: destructive commands, dangerous flag combos, risky pipes/redirects (overwrite), hidden execution (`base64 | sh`), download-and-execute (`curl | sh`), etc.
- Filesystem: reads of sensitive paths, recursive packing, bulk copies, credential directory access.
- Network: sending content to non-allowlisted domains, uploading files, posting sensitive text to webhooks/short-link services.

When blocking/approving, provide: what triggered the rule, why it’s risky, and safer alternatives (e.g., “send a redacted snippet or a summary only”).

### 4.5 Approval Workflows (MUST)
When a decision is `require_approval`:
- Pause the action, create an `approval_request_id`, and inform the user that approval is required.
- Support multiple approval channels (MVP):
  1) **Interactive TTY approval** (when running in a TTY, e.g. `run --task`):
     - Prompt in-terminal with a redacted action summary, risk reasons, and `Approve/Deny`.
     - If no input within a timeout, default to `deny` (fail closed).
  2) **Telegram DM approval** (admin-configured):
     - Send an approval card to admin chat(s) with ID, time, session identifier (optionally anonymized), action type, redacted parameter summary, reasons, and the default recommendation.
     - Provide **clickable buttons** (Inline Keyboard) for `Approve` / `Deny` (no typing required).
- Apply the decision:
  - `Approve`: continue the paused action (future enhancement: conditional approval like “only read first N lines / only send a summary”).
  - `Deny`: abort the action with a clear reason and suggested safe alternative.
- Timeout policy (MUST): e.g. deny after 5 minutes with reason `timeout`.

### 4.6 Configuration (MUST)
Configurable via YAML/TOML/JSON and/or env vars:
- Policy rules and thresholds: per tool/command/domain/path/regex for allow/deny/require_approval.
- Approval channels:
  - TTY prompt enable/disable, timeout.
  - Telegram bot token, allowed admin chat IDs, message templates, button callbacks.
- Allowlists: allowed directories, allowed domains, optionally allowed command sets.
- Logging/retention: audit log sink, redaction level, retention days.

### 4.7 Auditability and Observability (MUST)
Structured audit logs per event:
- `event_id`, timestamp, session/task identifiers, trigger source (input/tool output/user instruction/skill), action, risk level, outcome, matched rules, approval ID and result.
- End-to-end traceability: planned action → guard decision → approval → executed/aborted.

## 5. Design Notes (High-Level Architecture)

### 5.1 Components
- `Guard`: integrates with the agent lifecycle (input/tools/skills/output/memory) as the single enforcement point.
- `PolicyEngine`: converts rules + context + detector signals into a decision (`allow/deny/approval`).
- Pluggable `Detectors`:
  - `SecretDetector`: keys/tokens/private key blocks, etc.
  - `CommandRiskDetector`: dangerous shell operations and patterns.
  - `DataExfilDetector`: outbound content/file exfiltration risks.
  - `PromptInjectionHeuristics`: “ignore system”, “reveal hidden”, “exfiltrate memory” patterns (signal only).
  - `SkillPackageScanner`: scans downloaded skill payloads (SKILL.md + scripts/assets) for suspicious behavior.
- `Redactor`: redacts outputs and approval summaries.
- `Approver`: approval state machine (create, wait, timeout, persist).
- `Notifier`: approval notifications (MVP: Telegram notifier; extend later).

### 5.2 Decision Principles
- Least privilege by default: do not read or exfiltrate anything unless explicitly authorized.
- Fail closed for high-impact actions: uncertainty should not silently allow irreversible behavior.
- Explainability: every block/approval must provide actionable reasons.
- Layered defense: do not rely on “prompt rules” alone; enforce at tool/skill boundaries.

## 6. Interface and Data Model Sketch

### 6.1 Guard Evaluation
- `Guard.Evaluate(action, context) -> Decision`
  - `action`: `ToolCall | SkillRun | SkillInstall | MemoryRead | OutputPublish | ...`
  - `context`: session metadata, user-intent summary, source info (URL/file), previous risk events, etc.
  - `Decision`: `allow | allow_with_redaction | require_approval | deny` + `risk_level` + `reasons[]`

### 6.2 Approval Requests
- `ApprovalRequest`:
  - `id`, `created_at`, `expires_at`
  - `action_summary_redacted`
  - `risk_level`, `reasons`
  - `status`: `pending/approved/denied/expired`
  - `admin_actor`, `admin_comment` (optional)

## 7. Telegram Approval (MVP) Details
- Credentials must be provided via config/env (no hardcoding).
- Admin authentication: only allow pre-configured `chat_id` values to approve/deny.
- Message content must be redacted: do not send full file contents or full secrets—only the minimum necessary summary.
- Inline keyboard buttons:
  - `Approve` / `Deny` buttons with callback payload containing `approval_request_id` and action.
  - After a decision, edit the message to reflect the final state (optional but recommended).
- Concurrency and idempotency:
  - Repeated approvals for the same `id` must be idempotent (define first-wins or last-wins explicitly).
  - Expired requests must refuse execution and notify admin that the request is expired.

## 8. MVP Acceptance Criteria
- Guard can block and require approval for at least these scenarios:
  1) outputting or reading suspected secrets/private keys;
  2) executing dangerous shell commands (including variants like `rm -rf`, `curl | sh`);
  3) sending sensitive content to a non-allowlisted external domain;
  4) installing a downloaded skill that triggers the skill package scanner.
- Approval loop is end-to-end:
  - create request → notify (TTY and/or Telegram) → approve/deny → proceed/abort → timeout denies.
- Auditing works:
  - each interception emits an `event_id` with reasons and final outcome.
- Secure defaults:
  - detector failures or unknown states must not silently allow high-risk actions.

## 9. Milestones
- M1 (Guard MVP): tool + skill interception, rule engine, TTY + Telegram approvals (buttons), audit logs, output redaction.
- M2: conditional approvals (summary-only/partial file reads/allowlist expansions), more notification channels.
- M3: policy management UI, regression corpus for prompt injection patterns, richer detectors and telemetry.
