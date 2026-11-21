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
