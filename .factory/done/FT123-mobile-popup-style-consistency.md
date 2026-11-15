---
branch: factory/FT123-mobile-popup-style-consistency
round: 1
---
# Mobile popups: shared More-menu and agent-switcher presentation

## factory · 2026-11-15 08:59

Owner request:
> On mobile, all popups (desktop-style dropdown menus, dialogs, and popup bubbles such as bottom nav More) should follow the More menu and agent switcher: rounded top-left/top-right corners, small side margins, slide in from top, safe area.
> Write down to design/ and add to new/.

Design specification: `design/mobile-popups.md` on `master` (also indexed in `design/README.md`).

Acceptance criteria:
- Inventory all app-controlled mobile menus, dialogs, and popovers; apply the shared More-menu/agent-switcher presentation to every category, not just navigation popups.
- Use consistent rounded top corners, small left/right margins, reference surface styling, and a slide-in-from-top entrance. Match the visual reference without changing the requested motion direction.
- Respect safe-area insets, bottom-nav clearance, narrow widths, landscape, and software keyboard changes; constrain tall content and keep actions reachable through internal scrolling.
- Preserve popup behavior, accessible names/roles, focus handling, appropriate dismissal, readable text, and touch targets; respect reduced motion. Leave native OS/browser pickers native.
- Keep desktop presentation and behavior unchanged.
- Add regression coverage for representative menu, dialog, and bubble/popover cases, including More and the agent switcher, and verify safe areas, overflow, entrance direction, keyboard, and desktop behavior.
- Keep the design document consistent with the implementation.


## factory · 2026-11-15 09:20

Updated owner request (supersedes the earlier top-corners-only and side-margins-only requirements):
> On the mobile view, all popups (popup menus like desktop dropdowns, dialogs, and popup bubbles like the bottom navigation More button trigger) should follow the design and style of More and the agent switcher: round corners on all corners, small margins on the left, right, and bottom, slide in from top, safe area.
> Write a design file and add this request to new status.

Keep FT123 in `new/`; this is an update, not a duplicate request. The revised design document is `design/mobile-popups.md`. Ensure this document is included/updated in the implementation branch; do not assume the earlier note saying it is indexed on master proves that it is present there.

Updated acceptance criteria:
- Round all four corners on every app-controlled mobile menu, dialog, and popup bubble/popover, including More and the agent switcher themselves where necessary.
- Keep small, consistent left, right, and bottom margins, in addition to safe-area clearance. The bottom margin must remain visible above the bottom safe-area inset.
- Slide in from the top; entrance direction does not require top anchoring. Respect reduced motion.
- Match the More-menu/agent-switcher surface styling, preserve interaction and accessibility, handle narrow widths, landscape, tall content and the software keyboard, and leave desktop and native pickers unchanged.
- Inventory all mobile popup surfaces and add representative regression coverage for each category, all-corner rounding, three-side margins, safe areas, overflow, motion and unchanged desktop behavior.

Design specification to include in the implementation:

# Mobile popup presentation

Implementation tracking: FT123 on the factory board. This specification supersedes the earlier top-corners-only requirement.

## Scope

All app-controlled mobile popup menus, dialogs, and popup bubbles/popovers must follow the design and style of the bottom navigation More menu and mobile agent switcher. This includes menus presented as dropdowns on desktop. Native browser and operating-system pickers remain native. Desktop presentation remains unchanged.

## Appearance and motion

- Round all four corners, not only the top-left and top-right corners.
- Keep small, consistent margins on the left, right, and bottom. Preserve these visible gaps in addition to applicable safe-area clearance.
- Match the reference surfaces, borders, shadows, spacing, and backdrop treatment. Bring More and the agent switcher into compliance too if necessary.
- Slide in from the top. This specifies the entrance direction, not a requirement to anchor every popup at the top of the screen.
- Respect reduced-motion preferences while preserving the final layout.

## Safe areas and scrolling

Respect applicable safe-area insets on all sides, including notches, rounded screen corners, and the home indicator. Keep the bottom margin above the bottom safe-area inset; preserve bottom-navigation clearance where appropriate.

Keep controls reachable on narrow phones, in landscape, and when the software keyboard opens. Constrain tall content to the available viewport and provide internal scrolling without horizontal overflow or clipped actions. Maintain readable text and usable touch targets.

## Interaction and accessibility

Preserve selection, confirmation, cancellation, appropriate outside-click dismissal, and Escape handling. Maintain accessible names and roles, focus restoration, and modal focus containment where applicable.

## Verification

Inventory menus, dialogs, and popovers across mobile pages. Check representative cases from every category, including More and the agent switcher, for consistent rounding on all four corners, left/right/bottom margins, entrance direction, safe-area spacing, scrolling, dismissal, and focus behavior. Verify narrow phones, landscape, software keyboards, reduced motion, and unchanged desktop presentation.

## factory · plan · 2026-11-15 10:38

### Behaviour
On mobile, opening any app-controlled menu, dialog or bubble/popover shows a shared More/agent-switcher-style floating surface with four rounded corners, visible small side and bottom gaps outside safe-area/keyboard clearance, and downward entrance from above. Reopening, empty lists, loading/error dialogs and first-run setup retain existing content and dismissal semantics. Tall surfaces scroll internally and retain reachable actions on narrow, landscape and keyboard-reduced viewports. Reduced motion disables displacement. Desktop and native pickers remain unchanged.

### Scope
Inventory all popup implementations and their callers (including ui.tsx menus/selects/date pickers, DialogLayer and wrappers, MobileBottomNav More and agent menus, composer/todo popovers and app-controlled bubbles). Share mobile geometry/presentation/motion where practical; do not restyle ordinary persistent panels, tooltips or native pickers accidentally. Update design/mobile-popups.md and its index to the latest all-corner/three-margin requirements and document the inventory. Do not modify backend behavior.

### Decisions
Use the existing mobile breakpoint and reference surface tokens; choose a small consistent gap based on those references rather than changing desktop defaults. Entrance is a negative-Y-to-zero translation, not a top anchoring requirement. Reserve safe-area and keyboard occlusion outside the paper, with explicit navigation clearance where appropriate, avoiding double-counted insets. Prefer existing shared wrappers; any app-controlled nsh primitive that cannot expose mobile geometry/motion must be wrapped or given an app-controlled equivalent without changing accessibility/interaction. Preserve focus containment/restoration and existing back/Escape/outside dismissal policy.

### Checking
Add representative menu, dialog and bubble/popover tests plus More/agent-switcher checks for all four corners, left/right/bottom gaps, safe areas, tall content, narrow/landscape/keyboard geometry, negative-Y entrance, reduced motion and desktop invariance. Run nsh check and scripts/test.sh for Console changes, plus configured gofmt/vet/Go tests. Use throwaway absolute HOME for scripted tests. Report explicitly any unperformed visual/device/focus verification; do not claim screenshots or manual verification without performing them.

## factory · 2026-11-15 10:38

Built and pushed `493e2237` on `factory/FT123-mobile-popup-style-consistency`, starting at `137458ce` (master). Shared floating mobile popup paper covers menus, selects, date pickers, dialogs, More, agent switcher, composer pickers and attach surfaces. Four 16pt corners, 12pt left/right/bottom gaps outside safe-area/keyboard clearance, top-down entrance, constrained internal scrolling and reduced-motion behavior. Updated design/mobile-popups.md with the revised requirement and implementation inventory.

Decisions: mobile means under 720pt, plus touch windows through 980pt for landscape. Touch dropdowns use the shared paper even on wider tablets; pointer desktop dropdowns and centred dialogs retain their presentation. Native pickers, persistent side panels/workbench, inline suggestions and tooltips remain unchanged. nsh touch primitives cannot expose the required motion/geometry, so app-controlled wrappers retain their triggers and supply the paper/list/calendar. No current range date-picker callers; the replacement does not support range selection.

Installs: none; reused pinned nsh 0.5.0 and existing browser-test tooling. No dependency manifest/lock changes.

Checking: manager independently reran configured `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` (pass), `nsh check` (pass), and Console `scripts/test.sh` (118 files, 0 failed, 191s). git diff --check passed; no never paths changed and only this item's commit was added. Coder also reports headless Chrome checks of More, agent switcher, composer add, attachment and contact menu for corners/gaps/motion/dismissal; final attachment cap/handle change was only headless-test rechecked.

Not checked / review attention: no real Android/iOS device, emulator, actual software keyboard or GPUI desktop app. Browser visuals did not cover select/date/model pickers or general Modal/MessageDialog/SettingDialog; focus containment/restoration not directly asserted (browser focus was BODY during touch-opened attachment dialog). Menu Home/End/typeahead behavior is not preserved by the new list; Up/Down/Enter are supported. Unlabelled DropdownMenu callers currently produce unnamed papers. Select trigger open-ring/chevron state is absent behind the mobile scrim. These interaction/accessibility gaps need review against acceptance criteria, despite passing tests.

Process exception: coder reported writing an auto-memory note outside the factory build directory, contrary to task restrictions; no such paths were committed. The manager did not modify those external files. Initial code push lacked repository-path credential context; the single retry with per-command credential.useHttpPath=true succeeded. No base branch or tag was pushed.


## factory · review · 2026-11-15 10:56
head: 493e22374d27a68ffb520bf88d9cee355a888ba9
verdict: pass
notes:
- [P2] web/console-nsh/components/shared/DateField.tsx:57-58: DateField ignores PopupSheet contentMax and uses an unscrollable View inside overflow-hidden paper. Headless Android at 844x390 with 24pt top/bottom insets gives a 318pt paper, clipping the calendar/time/Clear content; the combined probe needs about 393pt (production callers separately need roughly 347-349pt by code/layout subtraction). With a 200pt keyboard the paper drops to 142pt. Use Scroll bounded by contentMax and test reaching the time/Clear controls in landscape and with a keyboard. Example: TODO Run at on an 844x390 phone cannot scroll the clipped time field into view.
- [P3] web/console-nsh/components/ui.tsx:1077: The new modal command-menu paper is unnamed for all six production DropdownMenu callers, which omit label; probe confirms an empty layer name. Supply labels at call sites or require them. Example: Contacts overflow opens an unnamed paper containing Delete. The old menu itself was also unnamed; the new modal layer is the introduced surface.
- [P3] web/console-nsh/components/ui.tsx:1252: PopupList hard-codes filterAutoFocus=false, dropping caller autofocus in sheet mode; under-720pt pointer desktop windows therefore lose immediate type-to-filter, and PickerList also omits Home/End/typeahead. Example: open a searchable select in a 600pt desktop browser and type; no filter changes until clicking the filter. Preserve desktop autofocus and caller preference and restore list keyboard navigation.

Validation: Claude Code reviewed origin/master...HEAD (27 changed files). Configured gofmt/vet/go test command passed; nsh check passed; Console scripts/test.sh passed (118 files, 0 failed, 192s). Headless probes covered date geometry, menu/dialog nesting and keyboard selection/dismissal. Manager confirmed clean worktree, exact reviewed head and git diff --check. No installations or manifest changes; reused pinned caches. No P0/P1 found, so moved review/ -> ready/ under factory policy; P2/P3 remain for owner attention before shipping.

Residual risks: no real Android/iOS device, emulator, actual software keyboard, screen reader or GPUI desktop checks. Focus containment/restoration not directly asserted. Native stacked-overlay hit testing, composer closing-keyboard timing, extreme landscape minimum-height overflow, trigger expanded-state and the mobile/desktop breakpoint interpretation remain unverified. Design inventory lists a nonexistent Topic rows command menu and should be corrected. No source issue/PR or owner-linked issue/PR in the item; no GitHub comment required.


## factory · 2026-11-15 13:02
Shipped to master with Claude Code. Merge commit: d8e9b5afe649bd656d090966aec364f2c1d3d08f. Final tested and pushed head: 239920e552855bfff298c2580f914ed5d7cd17ed. No tag created or pushed, per owner instruction.
Final validation: gofmt cleanliness, go vet ./... and go test ./... passed (163 packages); nsh check passed; required Console scripts/test.sh passed (122 files, 1065 tests, zero failures after chat-attachments isolated retry); extra Node tests 274/274. No unpinned installs.
Integration conflicts resolved preserving both feature intents: web/console-nsh/components/ui.tsx.
Existing review P2/P3 notes remain unchanged. Combined glass/scroll-memory and popup UI not visually checked; no browser/device or platform build performed during ship. No linked GitHub issues or PRs to close. Branch retained (clean action not configured). Moved ready/ → done/.
