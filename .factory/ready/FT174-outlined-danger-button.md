---
branch: factory/FT174-outlined-danger-button
round: 1
---
# Add an outlined danger button

## factory · 2026-11-23 15:18
Owner request:
> outlined danger buttons.

### Where it is
The Console's `Button` (`web/console-nsh/components/ui.tsx`, `ButtonVariant`): today `primary`, `outlined`, `plain`, `danger` (solid red), `highlight` and `ghost-danger` (bare red text). There is no outlined button in the danger colour. `CircleButton` has the same set of looks for round icon buttons.

### Expected behavior
- A new variant, an outlined danger button: the outlined button's box (translucent fill, hairline, corners, sizes) with the danger colour for its hairline and its label or glyph. It is the quieter of two destructive buttons: `danger` stays the solid one for the confirming press, the outlined one is for a destructive action offered beside others.
- Every state the other variants have: hover and focus (a danger tint, not the neutral one), pressed, selected, disabled (its own paler colours, not a plain opacity) and loading (the busy beam in the danger colour, as `danger`'s). As a text button and as an icon button, in every size (`md`, `sm`, `xs`, `xxs`).
- The same in the light and the dark appearance, with the contrast the other outlined and danger buttons keep.
- `CircleButton` gets the matching look if a round outlined danger button is as easy; say so if it is left out.
- Listed in the UI component gallery: the `Button` demo (`/ui-components`) shows the new variant beside the others.

### Decisions left to the build
The request gives no place to use it. Add the variant and its gallery example; where an existing destructive button is clearly the quieter of two (and is `ghost-danger` or `outlined` today), it may take the new variant, but do not restyle destructive buttons across the Console without a reason, and list each one changed. How it relates to `ghost-danger` (keep both, or replace it) is open: keep both unless they turn out to be used for the same thing.

### Acceptance checks
- The variant in every state and size, text and icon, at desktop and phone widths, light and dark.
- Regression coverage beside the existing button tests (looks, the loading state, the disabled colours). Run `nsh check` and `web/console-nsh/scripts/test.sh`.
- Look at it in the running Console's gallery; record any visual check that could not be made.

Scope: the button variant, its gallery example and the few buttons that take it; no redesign of the other variants (the solid buttons' polish is a separate item).

## factory · plan · 2026-11-23 16:02
Behaviour:
- Add `outlined-danger` to Button: existing outlined dimensions/corners/translucent box with danger-coloured border and text/icon; danger-tinted hover, focus, active and selected; distinct disabled palette and red loading beam with presses blocked.
- Keep all existing variants and default behavior unchanged. Support md/sm/xs/xxs and text/icon forms. No new first-run data or empty/error flows: this is a presentation variant.
- Add the matching CircleButton variant, reusing shared look helpers where practical; retain its existing API, sizes and interaction behavior.
- Show the variant in the UI component gallery alongside others.
Scope:
- Shared button definitions/state treatment, gallery, and regression tests; theme tokens only if existing danger/outlined tokens cannot express the result. Do not change existing destructive-action call sites or polish solid buttons (FT175).
Decisions:
- Name `outlined-danger`, retain ghost-danger. No call-site replacements: no concrete quieter destructive action was requested. Round support is small and useful; include it. Use existing theme tokens wherever possible and preserve accessibility, sizing, reduced motion and blocked disabled/loading interactions.
Checking:
- Add regression checks for variant class/color mapping, hover/focus/active/selected, disabled, loading red beam and disabled interaction, all Button sizes and text/icon forms, and CircleButton where supported.
- Run required gofmt/vet/Go test command, nsh check and scripts/test.sh. Use throwaway HOME and caches under TMPDIR for scripted tests.
- Try gallery inspection in light/dark at desktop/mobile widths if available; explicitly record anything not visually verified (do not claim visual verification from source tests).

## factory · 2026-11-23 16:02
Built at 66cf94c4 (feat(console): add an outlined danger button).
- Added outlined-danger Button and CircleButton variants, danger-tinted hover/focus/pressed/selected, pale disabled colours and red Button busy beam; all four Button sizes and text/icon forms. Gallery and regression coverage included.
- Kept ghost-danger and all existing variants. No application call sites changed; no new theme tokens. Existing translucent outline/danger/close tokens provide both appearances.
- Installs: none.
- Checks: gofmt, go vet ./... and go test ./... passed; independently rerun by manager with canonical TMPDIR and throwaway HOME. An initial manager verification used a noncanonical TMPDIR containing /../, causing path equality failures; corrected environment passed without code changes.
- nsh check passed. Console scripts/test.sh: final full run 160 files, 0 failed. Initial run had an unrelated transient settings-integrations-channels notice test failure; it passed 3 isolated reruns. Final run's chat-attachments load-sensitive failure passed the harness retry.
- Coder reports headless Chrome gallery inspection at desktop 1400 and phone 390 widths, light and dark, using stubbed Console API; web build passed. Real Tab navigation, Android and desktop native apps were not checked; focus was inspected using scripted focus().
- Review attention: enabled red text meets 4.5:1 at rest/hover/focus/selected in both palettes; held pressed text can dip to roughly 4.4:1, comparable to existing solid danger hover. The 4% pressed overlay is intentionally subtle.

## factory · review · 2026-11-23 16:11
head: 66cf94c438331d6cf2b5578be058a936ada879ab
verdict: pass
notes:
- [P3] web/console-nsh/components/ui.tsx:573: CircleButton outlined-danger loses its selected appearance while hovered or focused: nsh state priority lets hover:bg-close/focus:bg-close override selected:bg-danger/12. Preserve the selected tint in those states, as the rectangular Button already does. Verified example in a scratch nsh viewStyle probe: focusing an unselected round button then toggling it on leaves the background at #b23b241a; a selected unfocused one is #b23b241f. Both selected and unselected focused buttons thus look identical.
- Reviewed all seven changed files against origin/master...HEAD (merge base 4ba41b9a; fetched base 5cd80432). No P0/P1 findings; branch merges cleanly with the fetched base. No code changes or commits made during review; worktree remains clean.
- Validation by Claude Code: required gofmt/vet/Go test command passed; nsh check passed; scripts/test.sh passed, 160 files, 0 failed, 339s. Four parallel failures (chat-attachments, chat-topic-drag, setup, dialog-sheet) passed the harness's isolated retry. Scripted checks used a throwaway HOME and canonical TMPDIR under this run.
- Installs: none; cached pinned TypeScript copied into throwaway HOME. No manifests changed.
- Residual risks: review did not inspect a running gallery/browser, light/dark desktop/mobile rendering, real Tab navigation or Android/desktop native apps. Held-press text contrast near 4.4:1 remains the build's disclosed limitation; no new visual contrast verification was performed in review.
