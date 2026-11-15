---
branch: factory/FT129-mobile-new-topic-transition-occlusion
round: 1
---
# Mobile new-topic slide transition fails to cover the topic list

## factory · 2026-11-15 15:57

Owner request:
> On the mobile view, when you click the plus button at the topics list page, it will slide in the new topic page. However it seems the new topic page has no bg color or its z-index is lower than the topic list page, during the sliding transition, the content of the topic list page doesn't be covered by the new topic page. Need to inspect and fix.
> Put to new/

Reproduction:
- Open the topic list on a mobile viewport with visible list content.
- Tap the plus button to open the new-topic page.
- During the slide-in, the underlying topic-list content remains visible in the area that should already be covered by the incoming page.

Requirements and acceptance criteria:
- Inspect the incoming page surface/background, transition wrapper, clipping, and stacking contexts/z-index to establish the actual cause; transparency and incorrect stacking are hypotheses, not confirmed diagnoses.
- Throughout the transition, every area occupied by the incoming new-topic page must cover the outgoing topic-list content with the intended theme-appropriate page surface. The not-yet-covered part of the outgoing page may remain visible as expected for a slide transition.
- Preserve the intended slide motion, safe-area layout, topbar/composer presentation, and navigation behavior. Fix the page/transition surface rather than removing the animation or indiscriminately raising unrelated z-index values.
- Check intermediate animation frames, not only the settled page; cover light/dark themes, narrow mobile screens, return navigation, and reduced-motion behavior. Avoid desktop regressions.
- Add appropriate regression coverage for page-surface opacity and stacking during the transition, and record any mobile visual checks that could not be performed.

## factory · plan · 2026-11-15 16:18
Behaviour: On a phone with topics, the incoming conversation/new-topic pane covers the outgoing list wherever its translated rectangle occupies, during push and pop as well as at rest. Empty/first-run, loading/error and reduced-motion cases retain their existing navigation and form behaviour.
Scope: inspect pane surface, clipping and stacking, fix the moving conversation surface and add regression coverage; preserve animation, safe areas, glass bar/composer and desktop presentation. Other pages are out of scope.
Decisions: use the opaque theme page surface on the actual mobile moving wrapper if transparency is confirmed; do not inflate unrelated z-index values.
Checking: opacity and stacking while both panes are mounted and at intermediate frames, narrow mobile, return navigation, reduced motion, themes and desktop. Run required Go and Console checks; record visual limitations.

## factory · 2026-11-15 16:18
Built and pushed `1f78f30d` on `factory/FT129-mobile-new-topic-transition-occlusion`; new/ → review/, round 1.
Cause: Chrome showed the conversation wrapper had rgba(0,0,0,0) background during the slide; clipping and stacking were already correct. Added PaneStack paper helper and opaque bg-background only when panes overlap; applied to the conversation wrapper, preserving motion/z-index/glass bar and desktop transparency. Added eight focused regression tests and updated fixtures/test IDs plus PORTING.md.
Decisions: leave other pages unchanged; no-topics phones use the same opaque frame colour. Both configured themes currently share the same palette.
Installs: none; no dependency manifests changed.
Tests: required gofmt check, go vet ./... and go test ./... passed, independently rerun by manager with throwaway HOME. Coder reports nsh check passed and required scripts/test.sh passed (123 files, zero failures, 193 seconds), also with throwaway HOME.
Visual checks: headless Chrome, stubbed API and 14 topics, slowed push/pop for new and existing topics at 390×844 and 320×568; three intermediate frames sampled. Viewed 390px screenshots confirm covered list content is hidden; 320px verified computed opaque background only. Desktop 1280×800 screenshot pixel-identical to base; list/return settled screenshots unchanged; reduced motion switches immediately. Configured dark/light opacity covered in tests, no distinct dark palette to view.
Not checked: real Android device/emulator; loading/error visual states; narrow screenshots not visually inspected. Mid-slide real-page behaviour checked in Chrome, held-frame headless regression uses PaneStack fixture. Existing suite covers loading/error. Settled new-topic text antialiasing differs with opaque surface. Existing plus/nav over return pane and first Back only blurring composer remain unchanged from base.
Push initially failed because credential helper lacked repository path; command-local credential.useHttpPath=true retry succeeded. No settings were changed.
Owner/reviewer: inspect intermediate mobile transition frames and verify on Android.
