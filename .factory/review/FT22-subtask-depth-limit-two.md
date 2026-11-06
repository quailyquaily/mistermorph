---
branch: factory/FT22-subtask-depth-limit-two
round: 1
---
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

## factory · plan · 2026-11-06 23:57
Behaviour: root depth 0 and depth-1 subtasks may create children through depth 2; attempts beyond that fail before callback or model execution. Preserve empty/error handling and result envelopes; no first-run migration.
Scope: shared guard, spawn tool whitelist and descriptions, local/channel child engines, delegation regression tests and relevant documentation. Exclude unrelated UI/config and root-only notification/memory behavior.
Decisions: fixed maximum 2, not configurable. Nested spawn is explicitly whitelisted and uses only the child's tools; preserve model profiles, cancellation and propagation.
Checking: exercise actual depth-0/1/2 chains in both runtimes, leaf tools, rejected depth 3, whitelist narrowing, cancellation and returned results. Run gofmt check, go vet ./... and go test ./....

## factory · 2026-11-06 23:57
Built in 86d16f73 (feat(agent): allow subtasks to nest two levels deep).
Raised the shared maximum to 2. Depth-1 children may receive their own explicitly whitelisted spawn tool; depth-2 children receive none. Both local and channel runtimes preserve nested profile selection and restrict tool access. Coder and bash delegation follow the shared limit; bash stays inline at the leaf. Updated descriptions and English documentation.
Added regression coverage for nested execution, worker identities, narrowed tool access, cancellation, model profiles, result propagation and rejected depth-3 callbacks/model calls.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with a throwaway HOME. No prohibited paths changed. No additional installs.
Not checked: live LLM providers and Console nested-worker rendering; no UI sources changed.
Moved new/ → review/. Branch pushed; not merged into master.
