---
branch: factory/FT169-mobile-back-navigation-subpages-only
round: 1
---
# Show mobile back navigation only on subpages

## factory · 2026-11-20 23:29
The owner requested: "On mobile view, only the sub page has a back action (and geasture), root page has no back action" and asked to add this to new/.

### Requirements
- On mobile, show and enable the page back action only for subpages with an in-app parent.
- Root pages such as Topics, Contacts, and TODO must have no page back action and must not activate the app's back/swipe-back gesture.
- Apply the same page-hierarchy rule to the visible back control and the app-managed back gesture. Do not use browser-history length alone to decide: arriving at a root page from another page must not give that root page a back action.
- Subpages retain a working back control and back gesture that return to their appropriate parent, including when opened directly.
- Keep desktop navigation and unrelated gestures unchanged. Do not attempt to override the browser/OS's native back navigation; this request concerns app-provided controls and gesture handlers.

### Acceptance checks
- At mobile widths, root pages have neither a back control nor an app-handled back gesture, including after switching between top-level destinations.
- Subpages have both working back controls and app back gestures; returning to a root removes both.
- Cover direct-entry subpages, root/subpage transitions, and gesture eligibility with regression tests; verify representative mobile routes visually.

## factory · plan · 2026-11-20 23:37

### Behaviour
At phone widths, only subpages/details with an in-app parent have page back controls and app-managed back handling. Root destinations never acquire back eligibility from history. Direct-entry subpages return to their appropriate parent. Returning to a root disables page back immediately, including outgoing-page animations. Empty/loading/error states obey the same hierarchy. Preserve overlay dismissal, unrelated gestures, desktop behaviour and native browser/OS navigation.

### Scope
Inspect and update real Console mobile back controls, page-specific parent actions and SystemBackScope registrations. Constrain or remove the generic history fallback in systemBack where it grants roots app back handling. Add regression coverage; no backend/native OS navigation changes.

### Decisions
Use existing page hierarchy and parent actions, not a new navigation framework. Explicit parent actions take precedence over history. Preserve overlay dismissal. Follow repository-pinned nsh version (AGENTS.md currently specifies 0.6.0).

### Checking
Run configured gofmt check, go vet ./..., go test ./..., nsh check and web/console-nsh/scripts/test.sh. Test root-to-root navigation, root/detail transitions, direct-entry subpages and gesture eligibility on representative web/Android fixtures. Attempt mobile visual verification; explicitly disclose any unavailable visual inspection.

## factory · 2026-11-20 23:55
Built and pushed `60532090` on `factory/FT169-mobile-back-navigation-subpages-only` (round 1).

- Removed Android's generic history fallback: only an eligible page/overlay action handles app Back. Roots do not acquire a back action from history.
- Skill Store now registers its visible parent action. Logs now has a phone-only back control and matching handler returning to Settings → System, including direct entry. Existing detail-page registrations retained.
- Added eight mobile-back regression tests and updated tests which expected Back to walk between root destinations. Updated English navigation docs.
- Decisions: reuse existing page-specific hierarchy and SystemBackScope; preserve overlay priority and native browser/OS handling. Wide Android roots also no longer consume Back based only on history. Setup repair/not-found pages without a visible back control do not consume app Back.
- Installs: no unpinned installs.
- Checks: `nsh check` passed (repository-pinned nsh 0.6.0); required Console test driver passed, 154 files, zero failures after its isolated retry of chat-attachments. Configured gofmt/vet/Go suite passed; manager independently reran it successfully.
- Visual verification: headless Chrome at 390×844 checked root pages, Contacts detail, Logs, Settings System and Skill Store; wide Logs checked at 1280. Visual build used locally available nsh 0.5.1 web runtime, not 0.6.0. No physical Android/emulator check; Back/edge-gesture eligibility covered via headless Android harness only.
- Branch push initially failed because the credential helper lacked the repository path; command-local credential.useHttpPath=true resolved it on the single retry. No user git configuration changed.

## factory · review · 2026-11-21 00:08
head: 605320901dd1ee1801b69c513ee6d6b916256db8
verdict: pass
notes:
- Claude Code reviewed all 13 changed files against the request and plan on origin/master...HEAD. No findings.
- Validation: configured gofmt/vet/Go tests passed (166 packages); nsh 0.6.0 check passed; required Console test driver passed (154 files, zero failures, no isolated retries). Worktree clean and HEAD unchanged after review.
- Installs: no unpinned installs; existing cached TypeScript toolchain copied into the throwaway test HOME.
- Residual risks: no physical Android/emulator check or new visual inspection; builder visual verification used nsh 0.5.1 web runtime. Android JVM tests not run because JDK unavailable.
- Owner check: Android navigation roots, including wide windows, no longer consume Back based on earlier page history; native Back may leave the app. Confirm this intended behaviour on a device before release.

## factory · 2026-11-21 18:29
Shipped with Claude Code. Merge commit `3114a8539e18411bcf9e5eb5a168966b2bd38a85`; annotated release `v0.3.125`. Remote master and peeled tag verified at `b2628af670fd6a146c65513f6f0a1caf11f00137`. Both merges conflict-free; no fix commits or installs.

Validation: gofmt/vet/Go tests passed (166 packages ok); nsh 0.6.0 check passed; required Console runner passed (155 nsh test files plus inventory/scanner checks), dialog-sheet passed prescribed isolated retry. Console Node 329/329; scanner/Android manifest 22/22; Cloudflare 24/24 (overlapping checks, not additive).

Limits: Android roots no longer consume Back based on history; native Back may leave the app. No fresh device/visual/JVM validation.
No linked issues or PRs identified; none closed. Branch retained: clean not configured. Moved ready/ → done/.
