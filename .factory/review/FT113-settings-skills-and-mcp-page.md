---
branch: factory/FT113-settings-skills-and-mcp-page
round: 1
---
# Settings: combine Skills and MCP on one page

## factory · 2026-11-14 06:58
Owner request from Console:

> Rename settings -> MCP to "SKILLs & MCP", move the skill option from Tools to "Skills & MCP" page.
> Put to new/

### Required behavior
- Rename the existing Settings MCP navigation entry and page heading to "SKILLs & MCP". The request also uses "Skills & MCP" for the same destination; use "SKILLs & MCP" consistently as the explicitly requested label.
- Move the existing skill option and its associated controls from Settings → Tools to the renamed page, alongside the existing MCP settings.
- Preserve the skill option's current behavior, saved values, defaults, and persistence. This is a UI regrouping, not a configuration-key rename or behavior change.
- Keep existing MCP controls and functionality intact, and leave unrelated Tools options on the Tools page. Avoid duplicate skill controls on both pages.
- Update relevant navigation labels, localized strings, and help text. Preserve existing MCP settings links/routes where practical, or redirect them to the renamed destination.

### Acceptance checks
- Settings navigation and the destination heading show "SKILLs & MCP" on desktop and mobile without overflow.
- The skill option is available and functional on that page and no longer appears under Tools.
- Previously saved skill settings remain selected after the move; changing them still persists across reloads.
- Existing MCP configuration and unrelated Tools controls continue working; existing links to MCP settings still resolve.
- Add or update relevant UI regression tests; state any browser checks that could not be performed.

Status: requested only; not implemented yet.

## factory · plan · 2026-11-14 13:25

Behaviour: /settings/mcp displays Load skills above the existing MCP controls; existing skills.enabled values and defaults remain unchanged. Skill saves send skills.enabled only; MCP saves send mcp only, retaining the other draft. Loading, unsupported and read-only runtimes keep their existing guards; save errors remain visible. Tools no longer duplicates the switch.

Scope: settings UI/store, navigation/localization/search/help and regression tests. No backend schema or configuration-key changes; unrelated Tools settings stay put.

Decisions: use the exact label SKILLs & MCP across locales, retain the mcp section identifier and route, and preserve independent save behavior.

Checking: regression tests for labels, Tools absence, persistence payloads, independent saves, unsupported/read-only/loading cases and failures; full Go gate, nsh check and nsh test. Physical desktop/mobile browser checks unavailable.

## factory · 2026-11-14 13:25

Recovered the clean item commit left by a stopped build, reused its worktree, and had Claude Code finish validation. Built and pushed 2abdf31546766e60fc05eaec5bf28c72d4d04621 on factory/FT113-settings-skills-and-mcp-page.

Moved Load skills to SKILLs & MCP, preserved /settings/mcp, separated skill/MCP save payloads, and updated localized labels, search/help, docs and regression coverage. No new installs reported.

Tests: manager independently passed the configured gofmt + go vet ./... + go test ./... gate and nsh check. Claude validation and the recovered same-head test log confirm nsh test --web-host tests/noHost.js: 932 passed, 0 failed, exit 0. A redundant manager full UI rerun exceeded the foreground command time limit; the completed same-head suite is the recorded result.

Not checked: actual browser/device rendering, manual mobile overflow and interactive persistence across a real reload. Review should inspect those UI cases. Initial branch push needed credential.useHttpPath=true; retry succeeded without changing stored git settings.
