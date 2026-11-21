---
branch: factory/FT171-job-references-definition-and-latest-result
round: 1
---
# Reference scheduled jobs with their definition and latest completed result

## factory · 2026-11-21 19:34
The owner approved the discussed requirements and requested adding this item to new/. Support referencing scheduled jobs in task content, supplying the job definition and latest completed output as read-only context.

### Requirements
- Use canonical Markdown references such as `[Morning report](job:<id>)`, keyed by the stable job ID, not its display label. Provide a job picker in the Console editor using existing reference UI conventions; keep manual reference entry working.
- Resolve references at task start, including scheduled task execution. Supply the referenced job's instructions, schedule/timezone, enabled state, and latest run status, together with the latest finished run that has usable output.
- If a newer run failed or is still running, use the previous finished output and clearly state its timestamp and the newer run's status. Do not present older output as freshly generated.
- If no usable output exists (never run, expired/removed output, or unavailable storage), include the definition and an explicit result-unavailable note, and continue the task. Do not invent output or treat missing output as a successful empty result.
- An unknown, deleted, or inaccessible job reference stops the task before model execution with a clear, safe error. Do not silently omit the reference or disclose whether an unauthorized job exists.
- Job references are read-only: never execute, wait for, enable, disable, update, or delete the referenced job. Do not recursively expand references inside a referenced definition or result; self-references and cycles must not cause recursion.
- Enforce requester access and destination visibility before injecting context; do not expose private job content in shared conversations. Never include secret environment values, credentials, or private runtime configuration.
- Clearly delimit referenced definitions/results as source data, not new executable instructions. Handle duplicate references consistently without repeated expansion. Use existing context-size limits and explicit truncation indicators when necessary.

### Scope and lifecycle
- Investigate the actual run/output storage and retention paths; output is separate from the job record. Reuse existing stores and authorization boundaries rather than assuming the job record contains output.
- Keep current one-time-job deletion behavior for this item. Once a one-time job is deleted, its reference follows the deleted-job error behavior above, even if historical output remains. Retaining definition snapshots or adding archived-job references is out of scope; document this limitation.
- Do not add dependency scheduling, automatic triggering, recursive expansion, or a new output-retention guarantee.

### Acceptance checks
- Cover manual syntax and picker insertion, ID-based resolution after rename, interactive and scheduled execution, definition plus output, and correct timestamps/status when using an older result.
- Cover never-run jobs, unavailable/expired output, newer failed/running runs, deleted one-time jobs, unknown/deleted references, and inaccessible or unsafe shared-chat references.
- Cover secret exclusion, referenced-text instruction isolation, duplicates, self/cyclic references, context limits, and assurance that reference resolution causes no job execution or mutation.
- Run required backend and Console checks; visually verify picker behavior. Document the syntax, fallback/error behavior, and one-time-job limitation.

## factory · plan · 2026-11-21 20:21
## Behaviour
Parse canonical [label](job:<stable-id>) references once per ID at task start, before any model/precheck call. Load current definitions and authorized run/output history, not just the scheduler's transient run board. Authorize requester and destination before fetching/injecting content; unknown/deleted/denied use indistinguishable safe failure. Include allowlisted definition fields, latest run status, latest usable finished output and explicit original timestamps; newer running/failed runs must not disguise stale output. Missing usable output is nonfatal with explicit unavailability. Never resolve nested references or mutate/run jobs. Delimit source data and bound context with explicit truncation. Console picker follows existing reference insertion conventions, while typed references remain supported.

## Scope
Implement a small shared job-reference resolver and integrate actual interactive and scheduled execution entry points, existing stores/authorization and Console editor picker/API. Add targeted backend and Console regression coverage and English user documentation. No dependency scheduler, archive snapshots, retention guarantees, or changes to one-time deletion.

## Decisions
Stable ID is authoritative; display labels are cosmetic. Deduplicate in appearance order. Expose only instructions, schedule/timezone, enabled state and safe run metadata/output; never environment values or runtime secrets. Default deny where ownership or destination visibility cannot be established, including shared destinations; reuse existing access checks, do not infer that authenticated means access to every job. Keep resolution at task start so rename/output changes are current. Investigate durable task journal/output storage and existing budget controls before selecting APIs. Follow current repository-pinned nsh version (AGENTS says 0.6.0; factory's older version annotation is not a reason to downgrade).

## Checking
Cover picker insertion/manual syntax, ID resolution after rename, interactive and cron calls before model execution, output fallback/timestamps, never-run/expired/unavailable storage, failed/running newer executions, deleted/unknown/denied references, private-to-shared denial, secret allowlisting, duplicate/self/cycle handling, data isolation, explicit truncation and no mutations. Run gofmt gate, go vet ./..., go test ./...; Console nsh check and scripts/test.sh (parallel files, isolated retry, NOT whole-suite sequential nsh test). Try browser visual picker verification; explicitly report when unavailable.

## factory · 2026-11-21 20:21
Built in c3bdb5d3, 9e347244 and 5c560ee2 (head): stable-ID job references, bounded read-only definition/result context, stale-output timestamps and missing-output notes, safe denial, execution-start integration, Console editor job picker, regression tests and English docs.

Decisions: definitions are allowlisted; references deduplicate without recursive expansion. Access follows existing owner/destination boundaries because jobs have no creator field: private owner conversations may read definitions; shared scheduled destinations can only reference jobs with the same destination. This policy and cross-runtime output visibility deserve review. Output uses the job topic's latest 50 run records; no new retention guarantee. One-time jobs keep existing deletion behaviour.

Installs: none; no dependency manifests changed. Existing Go/nsh caches and existing playwright-core were reused.

Tests: coder passed gofmt, go vet ./..., go test ./... (167 packages), nsh check and required Console scripts/test.sh (156 files, zero failures). Manager independently reran the full configured backend gate successfully and verified commit scope and protected paths. Worktree clean; branch pushed.

Visual verification: coder checked picker/filter/caret insertion/focus/manual entry/save on headless Chrome at desktop and mobile sizes, using stubbed API and existing 0.5.1 web runtime (installed nsh is 0.6.0). Not checked: real Go-server/LLM end-to-end, desktop/Android apps, Heartbeat editor visuals, channel-specific runtime tests. Escape with filter focus follows the existing mention picker's non-closing behaviour. Cross-runtime output may be unavailable and is reported as such. No installs or unresolved backend test failures.
