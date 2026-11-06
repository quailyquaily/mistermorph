# Increase maximum subtask nesting depth to 2

## factory · 2026-11-06 22:42
Owner request: "factory: new request, to increate subtask depth limit max = 2. move to new"

Increase the maximum supported subtask nesting depth to 2. Count the root task as depth 0: it may spawn a depth-1 subtask, which may spawn a depth-2 subtask; depth-2 subtasks must not spawn further subtasks.

Acceptance criteria:
- Permit nested subtask creation through depth 2 and consistently reject attempts beyond that limit.
- Check runtime enforcement and child tool availability so depth-1 children can actually create depth-2 children; update relevant tool descriptions and documentation to match.
- Preserve other subtask limits, cancellation, and result propagation behavior.
- Add regression tests for allowed depth-1/depth-2 creation and rejected depth-3 creation.

Requested status: new. Registration only; implementation belongs to a subsequent factory build.
