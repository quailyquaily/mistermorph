---
branch: factory/FT99-secret-input-height-and-edit-actions
round: 1
---
# Match secret input height and contain edit-mode actions

## factory · 2026-11-12 23:29
Owner request:
> new UI fix:
> the secret input's height should be same as the regular input;
> the secret input, if click "replace" or "edit", the input switch to edit mode, but the buttons overflow, out of the input box.

### Expected behavior
- Secret input controls match the height and vertical alignment of regular inputs in the same form, in both display and edit modes.
- Clicking Replace or Edit switches the secret control into edit mode without its action buttons overflowing the control boundary or overlapping the editable text.
- Keep the field and its actions usable at narrow/mobile widths and in web and desktop layouts. Longer translated labels must not break containment; use a responsive layout rather than clipping or hiding required actions.
- Preserve secret handling, masking, save/cancel behavior, keyboard interaction, and focus behavior. This is a UI layout fix, not a change to keyring or secret persistence policy.

### Acceptance checks
- Compare a secret field with a neighboring regular input: their outer heights and alignment match before and after entering edit mode.
- Exercise both Replace and Edit wherever available, including empty, existing-secret, and populated-edit states.
- Confirm all action buttons remain inside the intended field layout and are fully clickable at desktop and narrow/mobile widths; text remains editable without overlap.
- Add regression coverage for sizing and edit-mode action containment. Run the configured repository and Console checks/tests.
- Visually verify the affected controls in display and edit modes at desktop and mobile widths; explicitly record any visual checks that could not be performed.

Scope: shared secret-input layout and directly affected callers only; no unrelated settings redesign or secret-storage changes.

## factory · plan · 2026-11-13 00:53

Behaviour: A secret field matches the neighboring default TextField height and alignment in empty, stored, picked, environment-managed and editing states. Replace/Edit enters editable mode while retaining masking, reveal, picker, cancellation, keyboard and focus behavior. Buttons remain clickable inside the field layout at mobile and desktop widths without overlapping typed text; localized labels must not force overflow. Errors and password prompts remain usable and wrap only where needed.
Scope: Shared SecretInput and directly affected EnvManagedField, the smallest shared TextField sizing adjustment if needed, and targeted layout fixtures/tests. No persistence, keyring, configuration or unrelated settings redesign.
Decisions: Use the actual repository TextField sizing as the source of truth, nonshrinking action controls and shrinking text/input areas. Icon actions with accessible translated titles are acceptable if all required actions remain discoverable. Password confirmation action rows may wrap responsively. Reuse the interrupted build's relevant changes, but inspect and simplify anything unnecessary.
Checking: Add regression cases for empty/stored/edit/picked/env/password states and action bounds/height equality at desktop and narrow widths, including long labels. Run configured gofmt/vet/go test and nsh check plus nsh test --web-host tests/noHost.js. Visually check desktop/mobile if available; explicitly state any checks not performed. Test HOME must be throwaway and absolute.

## factory · 2026-11-13 00:53

Built and pushed commit ab607c31b8e9c39716a26e89607e6d6bd988cbc2 on factory/FT99-secret-input-height-and-edit-actions.

Secret fields and EnvManagedField now share the regular TextField height (44pt). Input/text can shrink, action rows cannot, and the negative edit-action margin is removed. Masks remain single-line with a minimum visible width, storage tags shorten, and password actions wrap on narrow screens. Secret handling and persistence are unchanged.

Recovered an interrupted build's relevant uncommitted files, preserved a copy, and finished them with Claude Code. No new installs or manifest changes in this run; reused existing pinned nsh 0.5.0 tools.

Checks: configured gofmt check, go vet ./... and go test ./... passed with throwaway HOME; manager independently reran the full configured gate successfully. nsh check passed; full nsh test --web-host tests/noHost.js passed: 826 passed, 0 failed. Added 10 secret-input layout/interaction regression tests; coder confirmed all 10 fail with the old layout values, and two fail without the mask-width fix.

Visual checks reported by coder: before/after isolated component fixtures in headless Chrome at 320 and 1280 widths, English and Japanese, screenshots inspected and phone taps/desktop clicks exercised. Password prompt visually checked in English only. Full Console, native desktop and Android device/emulator were not visually checked; review should inspect those contexts. No changes outside the planned six Console component/fixture/test paths or to forbidden paths.

Initial branch push failed because the credential request lacked a repository path; command-local credential.useHttpPath=true resolved it on the single retry. No persistent git settings changed.

## factory · review · 2026-11-13 01:22
head: ab607c31b8e9c39716a26e89607e6d6bd988cbc2
verdict: pass
notes:
- Claude Code reviewed all six changed files against origin/master...HEAD (merge base 8b021ee4); no qualifying P0/P1/P2/P3 findings introduced by this change. Branch merges cleanly with the fetched base; no code changes or commits made during review.
- Validation with throwaway HOME: configured gofmt check, go vet ./... and go test ./... passed; nsh check passed; nsh test --web-host tests/noHost.js passed (826 passed, 0 failed), including all 10 new layout regression tests. Used existing pinned nsh 0.5.0; no installs or manifest changes.
- Independent headless layout probes measured revealed 200-character secrets at 320 and 1280 widths in web and desktop runtime configurations: field height 44 matched regular input and actions stayed inside. Reviewed shared TextField callers and secret behavior preservation.
- Pre-existing residual issue, reproduced on origin/master: a picked plain-text key hint can shrink to zero at 320 width with a long source label. Not introduced by this diff; not a blocking finding.
- Review limitations: no screenshots or full Console visual inspection; native desktop and Android device/emulator not checked. Fixtures isolate controls rather than mounting real settings pages. Owner should visually check real settings at mobile/desktop widths, especially translated labels and password prompts.

## factory · 2026-11-13 08:37
Shipped ready/ → done/ on owner approval after current-head passing reviews and combined-base validation with Claude Code.
- Merge commit: db3c3e8e7033e782afbdd46698a59b28823dfb8f; released in v0.3.105, master head 588ad961617622bb1736cad1affe1ac4de56b721. Master and tag pushed atomically.
- Final checks: gofmt clean, go vet ./... passed, go test ./... passed; pinned nsh 0.5.0 check passed; full Console suite 851 passed, 0 failed. Scripted tests used an absolute throwaway HOME.
- No merge conflicts, unpinned installs or protected-path changes. No linked GitHub issues/PRs to close. Branch retained (clean is not configured).
- Real Android/native desktop and fresh full-app visual verification were not performed; prior review limitations remain.
