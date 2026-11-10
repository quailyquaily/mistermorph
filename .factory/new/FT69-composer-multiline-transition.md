# Fix composer intermediate state during single-line to multiline transition

## factory · 2026-11-10 16:35
Owner reports a Console composer UI bug: as text approaches the wrapping threshold, the composer changes height even though the text is still displayed on one line. There is an unintended intermediate state between the normal single-line and multiline layouts. Owner requests adding this issue to new.

Owner's suspected cause (not yet verified): entering multiline mode changes the available text width, so text that would have wrapped in the single-line layout no longer wraps after the layout switches. The mode decision and resulting geometry may therefore disagree.

Expected behavior: define a clear wrapping/multiline state. Once that state is entered, apply the complete multiline layout consistently rather than a partial height-only intermediate state. The transition must not oscillate as its own layout changes the measured width. Returning to single-line mode when text is sufficiently shortened must remain predictable; this is not a request to permanently lock multiline mode.

Scope: current nsh Console composer layout and its single-line/multiline measurement and state transitions. Confirm the cause before choosing a minimal fix; do not assume this is the same issue as FT68's Markdown editor pointer behavior.

Acceptance criteria:
- Reproduce the boundary by gradually typing into a single-line composer; record text width, wrapping measurement, mode and resulting height before and after the transition.
- Define consistent entry and exit conditions for multiline mode that account for layout-dependent available width. Avoid arbitrary character-count thresholds.
- At the boundary, show either the normal single-line layout or the complete multiline layout, with no partial/intermediate state or repeated mode/height flicker.
- Verify typing, deletion, paste, explicit newlines, clearing/sending, and viewport resizing across the threshold; include Chinese and Latin text and long unbroken strings.
- Preserve caret/selection, input focus, IME composition, send controls, and existing composer height limits and scrolling.
- Add regression coverage for the threshold and reverse transition, and verify the rendered behavior at desktop and narrow/mobile widths. Explicitly report browser or host behavior not verified.

Registered only; implementation and browser verification have not started. Root cause remains a hypothesis.
