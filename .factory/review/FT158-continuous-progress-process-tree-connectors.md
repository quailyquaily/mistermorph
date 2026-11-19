---
branch: factory/FT158-continuous-progress-process-tree-connectors
round: 1
---
# Keep Progress and Processes tree connectors continuous

## factory · 2026-11-19 19:24
Owner reports that the lines on the left of progress output break into multiple pieces and requests this fix in new/ after reviewing the diagnosis with Claude Code.

### Problem and scope
- The prior investigation found text-based tree prefixes (`│`, `├─`, `└─`) in `ChatProcessTree.tsx` and `ChatStatusCard.tsx` (`ActivityCallTree`). A one-line glyph cannot span wrapped command text, expanded content, nested children, or row gaps. Verify the current implementation before changing it.
- Fix both the Processes sheet and the Progress panel; preserve their existing content, hierarchy, status indicators, expansion behavior and interactions.

### Requirements and checking
- Replace character-based connector segments with layout-based strokes (borders, positioned views, or an equivalent simple approach) that follow each node's actual height and nesting.
- Keep vertical trunks continuous across wrapped commands, expanded details, child nodes and spacing. Align horizontal branches with node headers, and terminate the last sibling's trunk at its branch without a dangling line.
- Decorative connectors must not intercept input or enter the accessibility tree. Preserve readable indentation and existing light/dark styling.
- Add regression coverage for multiline commands, nested children, expanded content, single-child and last-sibling cases, including narrow layouts. Check desktop web, mobile web and Android rendering where available; report visual checks that could not be performed.
- This is a focused connector-rendering fix, not a redesign of either panel or a change to process/progress data handling.

## factory · plan · 2026-11-19 19:52
### Behaviour
Empty trees stay unchanged. Layout-based strokes follow each row's actual height through wrapped commands, shell/error details and nested descendants. Non-last siblings carry the trunk into the next row; the last trunk ends at the header branch. Preserve controls, expansion and omitted-call counts.
### Scope
Processes ProcessRows and Progress ActivityCallTree, a shared connector component, its UI inventory entry and regression fixtures/tests. No process/activity data changes or panel redesign.
### Decisions
Use native-supported positioned strokes in NEON.idle with fixed per-level indentation. Rows own spacing so connectors meet without seams. Decorations ignore pointers and are hidden from accessibility. Preserve current ActivityCallTree data behaviour rather than introducing recursion.
### Checking
Geometry/runtime regression tests for wrapping, nesting, expanded content, narrow layouts, single/last siblings and reactive sibling removal. Run nsh check, the required parallel Console test runner and configured Go formatting/vet/tests. Check desktop/mobile web where available; explicitly record unavailable platform checks.

## factory · 2026-11-19 19:52
Built and pushed commit 8466f319 on factory/FT158-continuous-progress-process-tree-connectors. Moved new/ → review/; round 1.
- Shared TreeBranch uses a 20pt column and 1pt strokes. Row-owned spacing keeps trunks continuous. Last sibling terminates at its branch; nested children draw their own connectors. Omitted-call rows retain their count on a dashed trunk.
- Preserved status, shell/error details, Stop controls and wrapping. Decorative columns ignore input and are hidden from assistive technology. Added component inventory entry and 8 regression tests.
- Tests: nsh check passed (0.6.0); required scripts/test.sh passed, 146 files, 0 failed (chat-attachments passed its isolated runner retry). Configured gofmt/vet/go test passed; manager independently reran all three successfully. Regression mutations broke 7/8 tests as expected.
- Installs: none beyond restoring repository-pinned dependencies; no manifest changes.
- Visual checks reported by coder: fixture rendering real components in headless Chrome, desktop 700pt and mobile touch 360pt. Headless Android geometry covered. No Android device/emulator, native desktop shell or live Console panel checks; dashed Android trunk visually unverified. Browser fixture used available web runtime 0.5.1, not 0.6; no separate dark screenshots because fixture forces light theme. Branch centres can differ by 0.5pt (about 1pt for wrapped process names).
- Branch push initially needed per-command credential.useHttpPath=true; retry succeeded. No global git settings changed.
