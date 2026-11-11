---
branch: factory/FT81-agent-name-set-selection
round: 1
---
# Choose the name set for subagents and coder

## factory · 2026-11-11 00:55
Requested by the owner in Console; placement and scope confirmed in the discussion.

Add an **Agent name set** dropdown to the **Tools page, below the individual tool settings**. This is a shared preference for both subagents (spawn) and coder, not a setting nested inside either individual tool.

Options:
- Great scientists (default; preserve the existing naming behavior)
- Great musicians
- Great artists

Persist the selected preference and use its name pool for newly created subagent and coder sessions. Existing sessions and historical names must remain unchanged. Changing the name set affects names only, not model selection or agent behavior.

Show a few example names for the selected set and a concise hint that it applies to new subagent and coder sessions. Follow the existing Tools page styling and settings persistence conventions.

Acceptance:
- The control appears below all individual tool settings on the Tools page.
- All three sets are available and survive reload via the existing settings mechanism.
- Both newly created subagents and coder sessions use the selected set.
- Existing names remain stable when the preference changes.
- Missing or invalid stored values safely fall back to Great scientists.
- Add regression coverage for selection/persistence, default fallback, both naming consumers, and unchanged existing names.

## factory · plan · 2026-11-11 07:22
Behaviour: Add the shared Agent name set dropdown below individual Tools settings, with scientists (default), musicians and artists, localized examples and a new-sessions hint. Persist with existing settings; missing/invalid stored values fall back to scientists. New spawn/coder workers use the chosen set; historical and resumed identities remain stable.
Scope: shared allocator and metadata, settings/runtime propagation, Tools UI, worker display/localization, config example and regression tests. No model/behavior changes.
Decisions: preserve scientist indices and legacy names, carry explicit stable set metadata for new records and resume state, avoid mutable global preferences, use stable curated pools and existing settings loading/save/error conventions.
Checking: selection/save/reload, invalid/default handling, real spawn and coder consumers, historical/nested/resumed identities, metadata roundtrips, localization, Go checks and Console checks/tests; inspect the UI if available.

## factory · 2026-11-11 07:22
Built and pushed ba55ab3c in four focused commits. Added tools.agent_name_set with three stable 32-name pools, localized Tools control/examples and worker names, runtime configuration propagation, and metadata/resume persistence. Each task retains its starting set; existing names remain unchanged. Unknown stored values default to scientists; invalid API writes return 400. Older runtimes hide the unsupported control.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with a throwaway HOME. Claude Code reported `nsh check` passed, Console suite 530 passed, and core Node tests 257 passed. Final tree passes; first two intermediate commits individually fail the cross-language pool parity test because frontend pools arrive in the third commit.
UI: Claude Code reported Chrome checks against a real Console, save/reload persistence, desktop and 390pt mobile screenshots in en/zh/ja. Native desktop and Android were not checked; no live model-driven spawn/coder session was checked (engine integration tests cover naming).
Installs: none. Branch push initially required credential.useHttpPath=true; command-scoped retry succeeded. No protected paths changed. Moved new/ → review/ for review.

## factory · review · 2026-11-11 07:39
head: ba55ab3ce6a71edf2b2def119c811460e139bd76
verdict: pass
notes:
- Claude Code reviewed all 44 changed files against origin/master and the request/plan; no qualifying P0/P1/P2/P3 findings. Branch merges cleanly with master.
- Validation with a throwaway HOME: required gofmt/vet/Go test gate passed; nsh check passed; Console tests 530 passed; core Node tests 257 passed. No installs. Worktree clean and reviewed HEAD unchanged.
- Not checked in this review: live model-driven spawn/coder sessions, visual browser/native desktop/Android UI, and a complete runtime-generation rebuild following a settings save. Engine tests cover both consumers and approval-resume identity stability.
- Final tree passes; the first two intermediate commits fail the cross-language pool test individually, as already recorded in the build report.
- Moved review/ → ready/. No linked GitHub issues or PRs to comment on.


## factory · 2026-11-11 11:55
Shipped with owner authorization; ready/ → done/. Merge commit: be889431f9720924825561111592b2d5c1fc46fc. Tag: v0.3.95. Published master: fff6c8e23373119ee1ea60f05bee0a711fb334a0 (starting base d122775a1398b4294ea364f229a852ce59f6c93b). Remote master and annotated tag target verified. No linked issues or PRs to close.

Configured Go formatting/vet/tests and full Console check/tests passed after each approved merge and on the final tree. Final: 162 Go packages passed (19 without tests), Console 576/576, core Node 259/259, Android manifest 6/6; web build passed. All scripted checks used an absolute throwaway HOME and isolated runtime/cache directories with an environment whitelist. No installs, deployment, or intentional user-settings changes.

FT84 integration resolved TopicSidebar clock-versus-layout-probe conflict while preserving both approved changes. A separate test-only fix fff6c8e2 supplies FT71 runID/stopping fields to FT84 fixtures after an initial typecheck failure; all gates then passed. Initial offline module restoration also failed for unused uncached modules; dependency-targeted restoration succeeded.

Validation limits: no live browser/native desktop/Android or real keyboard checks, no live model-driven naming sessions, and no repeated race suite in this ship. Existing review caveats remain, including FT71 OpenAPI omission/one-time behavior and FT76's earlier unresolved real-state pollution. Coder reported contemporaneous real-HOME Go cache/telemetry writes of unknown attribution; ship checks used sandbox paths. No private user data cleanup attempted.
