---
branch: factory/FT101-voice-input-primary-button-recording-red
round: 1
---
# Style voice input as a primary button with a red recording state

## factory · 2026-11-13 00:29
Owner request:
> New UI fix: the voice input button, use the primary button just like the send button. When recording, change the bg color to red(icon is white)

### Expected behavior
- Style the composer voice-input button using the same primary-button treatment as the Send button, matching its height, shape, and interaction styling.
- While actively recording, use a red button background and a white icon. This supersedes FT88's red microphone icon treatment: the recording icon must now be white on red.
- Restore the normal primary-button appearance when recording ends or is cancelled, or a recording error occurs.
- Preserve existing recording, permission, disabled, loading, and accessibility behavior; this is a visual fix, not a voice-input flow redesign.
- Apply consistently wherever the shared composer voice button appears, including desktop and mobile layouts, in supported light and dark themes.

### Acceptance checks
- Compare idle voice-input and Send buttons for consistent primary styling and dimensions.
- Verify recording shows a red background with a white icon, including hover/focus states; an idle hover must not appear to be recording.
- Verify stop, cancellation, permission rejection, and errors leave no stale red recording state.
- Preserve visible keyboard focus and accessible recording labels/state; check narrow mobile layout for clipping or misalignment.
- Add/update applicable state/style regression tests and run configured repository and Console checks/tests.
- Visually inspect idle and recording states; record any unavailable desktop/mobile or visual checks.

Scope: voice-input button presentation only; no changes to Send behavior or recording backend.

## factory · plan · 2026-11-13 02:48

Behaviour: The shared composer voice button uses Send's primary circle styling and dimensions while idle. Only active recording changes its background to red and microphone to white; hover/focus must keep that distinction. Transcribing stays disabled with its loading beam and appropriate primary disabled styling. Stop, discard, permission denial and recording errors restore normal styling via the existing voice state. Preserve labels, selection/accessibility, hit targets and all voice actions on desktop/mobile, light/dark themes, empty composer and first permission request.
Scope: ChatComposer voice presentation and focused regression tests/fixtures only; reuse CircleButton and theme conventions. Do not change Send behavior, recording backend or voice lifecycle.
Decisions: Use existing primary button treatment rather than a new button implementation. Recording overrides primary fill, including interaction states, with existing danger/red palette and white icon. Follow repository's current nsh 0.5.0 instructions (factory config's 0.4.0 note is stale). Preserve loading semantics, adapting tint/beam to primary where needed.
Checking: Update obsolete FT88 red-icon tests to assert white-on-red recording vs primary idle, including disabled/transcribing, Linux/Android, narrow layout and cancellation/errors/permission denial. Run configured Go gate and nsh check + nsh test --web-host tests/noHost.js. Visually inspect idle/recording when available; explicitly report unavailable visual/device checks.

## factory · 2026-11-13 02:48

Built and pushed `20712aef69a24fce0669c5152e311210866d5ecb`; moved new/ → review/ (round 1).

- Idle voice input now uses Send's primary 38-point circle and white microphone. Recording uses a red danger circle with a white microphone, including its hover treatment. Transcribing uses the primary busy treatment. Existing voice lifecycle, labels, selection, disabled state and hit targets are preserved.
- Added a reusable danger CircleButton variant and updated voice presentation tests/fixtures, including Linux/Android and light/dark state coverage. No recording backend or Send behavior changes.
- Decisions: reuse existing primary/danger theme tokens; replace FT88's red icon expectation with a white icon on red. Follow current repository nsh 0.5.0 instructions.
- Installs: no new unpinned tool or dependency reported; existing nsh and browser tooling reused. No manifest or lockfile changes.
- Tests: configured Go gate passed (gofmt, go vet ./..., go test ./...), independently repeated by manager. nsh check passed; nsh test --web-host tests/noHost.js passed, 819/819.
- Visual checks: coder exercised idle/recording and hover in headless Chrome at desktop and narrow widths. Not verified: actual dark theme in Chrome, a visible keyboard focus outline, physical Android device, native desktop app. These remain owner/reviewer checks; automated dark-theme state coverage is not a visual dark-theme check.
- Push initially failed because credentials lacked a repository path; retry with command-local credential.useHttpPath=true succeeded. No persistent git settings changed.

## factory · review · 2026-11-13 03:24
head: 20712aef69a24fce0669c5152e311210866d5ecb
verdict: pass
notes:
- Claude Code reviewed all six changed files on origin/master...HEAD against the request and plan; base: 8b021ee48d7ebb6f25a581934e117a7711b3b797. No qualifying P0/P1/P2 findings. Nonblocking observations about fixture self-checks and inherited disabled/hover styling were not classified as introduced defects.
- Validation passed: gofmt listed no files; go vet ./... and go test ./... exited 0. nsh 0.5.0 check passed; nsh test --web-host tests/noHost.js passed, 819/819. Tests used throwaway HOME directories. Review worktree remained unchanged.
- Installs: none reported; reused existing tools and shared Go caches.
- Residual risks: reviewer could not visually inspect the composer because available browser attempts failed; no verified composer screenshot. Idle/recording/transcribing appearance, hover, keyboard focus, narrow layout and dark-theme rendering still need visual checks; headless state/style tests are not visual verification. Native desktop and physical Android were not exercised.
- Process: first coder return omitted its substantive report; a second Claude Code invocation recovered the existing test evidence and rechecked the diff without rerunning the long suite.
- Moved review/ → ready/. No linked GitHub issues or PRs were identified in the item.
