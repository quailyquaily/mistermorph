---
branch: factory/FT44-console-consistent-search-boxes
round: 1
---
# Consistent search boxes on Topics and Contacts pages

## factory · 2026-11-09 19:06
Owner request: "New UI fix: the search box on the topic page and contact page should be the same style, size, and position"

Queue this UI fix in new/.

Acceptance criteria:
- Topics and Contacts search boxes use the same visual style, including typography, colors, border, radius, icon treatment, and internal spacing.
- At matching viewport sizes, use the same height and width rules, and the same placement and spacing relative to the page header and content.
- Keep the layout consistent on desktop and mobile without overflow or overlap; preserve existing search behavior, accessible labels, focus handling, and clear controls.
- Reuse a shared component or styling where practical; do not redesign unrelated page content.
- Add regression coverage for the shared appearance/layout contract and confirm both pages visually at desktop and mobile sizes. Record any visual checks that cannot be performed.

## factory · plan · 2026-11-09 19:58
Behaviour: Topics and Contacts show the same responsive search field, including empty, loading and error states. Typing keeps each existing filter; focus, accessible labels, clear and Topics Escape-to-clear remain functional.
Scope: shared index-search field and spacing, the two consumers and regression tests. Other SearchField/IndexColumn consumers and unrelated content stay unchanged.
Decisions: use the Topics appearance, magnifier and clear button; 38pt desktop/44pt mobile height; shared desktop/mobile gutters and spacing directly below the existing 57pt header. IndexColumn gets an opt-in unpadded search slot to avoid double padding.
Checking: desktop/mobile shared appearance and geometry regression tests, filtering/clear/focus tests; nsh check and full nsh suite; gofmt, go vet and go test. Attempt actual browser visual checks and record limitations.

## factory · 2026-11-09 19:58
Built ad3ddf53 on factory/FT44-console-consistent-search-boxes. Shared IndexSearch now provides identical field styling, responsive size, gutters and header spacing. Contacts gains the magnifier, clear control and Escape-to-clear; existing placeholder and filtering remain. Both lists use 8pt spacing before the first row. Existing top slots on other pages are unchanged.
Installs: none; no manifest or lockfile changes.
Tests: manager independently verified gofmt clean, go vet ./..., go test ./..., nsh check and nsh test --web-host tests/noHost.js (321 passed, 0 failed), using a throwaway HOME. Coder also reports a clean nsh build. Added desktop/mobile consumer tests for accessibility, clearing, loading/empty/error states and a headless geometry fixture.
Not checked: actual desktop/mobile page screenshots and visual appearance. Headless Chrome could not load HTTP pages in this environment; geometry was checked with the layout fixture only. No Android SDK/emulator was available. Typed-input font size could not be inspected by the headless runner; both consumers share its implementation.
Moved new/ → review/. Owner should visually compare both pages on desktop and mobile before shipping.
