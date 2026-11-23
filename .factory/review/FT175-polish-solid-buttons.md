---
branch: factory/FT175-polish-solid-buttons
round: 1
---
# Polish the solid buttons: primary, danger and highlight

## factory · 2026-11-23 15:18
Owner request:
> the solid buttons like primary, danger, and hlight, need add some design details to make them polished, refined and elegant

### Where they are
The filled variants of the Console's `Button` (`web/console-nsh/components/ui.tsx`, `BUTTON_VARIANTS`: `primary`, `danger`, `highlight`), and the filled round buttons that share their fills (`CircleButton`'s `primary` and `danger`; the capsule toolbar's primary and danger buttons in `components/shared/CapsuleBar.tsx`; the composer's send button when it is ready). Their colours are the theme's (`theme.json`: `primary`, `primary-hover`, `primary-line`, `danger`, `warn` and their disabled tokens), in the light and the dark palette.

### Expected behavior
- The three solid buttons read as made, not as flat coloured boxes: the craft details a filled control carries, each small and quiet. What those are is the build's to find by looking; the usual ones are a hairline a shade deeper than the fill so the edge is crisp on any ground, a faint inner highlight at the top edge, a soft shadow that says the button is raised and deepens on hover, a pressed state that settles (the shadow goes, the fill deepens a step), and a focus ring that follows the corners.
- One language for all three: the same details in the primary, the danger and the highlight colour, so they are one family. The round filled buttons and the capsule's filled buttons take the same treatment where it applies, or the reason is stated.
- Every state keeps working and stays distinct: rest, hover, focus, pressed, selected, disabled (still clearly not pressable, with its own paler colours) and loading (the busy beam still reads on the fill).
- Light and dark each get values that suit them (a highlight or a shadow tuned for one palette is wrong on the other); text on the fill keeps its contrast (4.5:1 at least, as the theme's tests check).
- Motion is the compositor's: only `opacity` and `transform` animate, colours ease as they do now, and reduced motion zeroes the durations.
- Restyle what is there. No new elements, no gradients loud enough to notice as gradients, no glow.

### Decisions left to the build
The request names the feeling, not the details. Look at the three buttons as they are (every size, text and icon, light and dark, at 1x and 2x), list what is flat or uneven, and choose the details; record what was found and what each change is for. Whether the outlined and plain buttons need a matching touch so the family stays coherent is open: change them only where a solid button's new detail makes them look unfinished beside it.

### Acceptance checks
- Each solid variant in every state and size, text and icon, light and dark, in the UI component gallery (`/ui-components`, the `Button`, `CircleButton` and capsule demos).
- Hairlines land on device pixels at 1x, 1.5x and 2x; nothing is clipped by a parent's corners; the focus ring is whole.
- The theme's contrast checks still pass; existing button tests updated for the new looks, with coverage of the pressed and disabled looks. Run `nsh check` and `web/console-nsh/scripts/test.sh`.
- Look at the result in the running Console on real pages (a dialog's confirm, the Jobs composer's Add, a delete confirmation); record any visual check that could not be made.

Scope: the filled button looks and the tokens they need; no change to button sizes, labels or where buttons are used. The outlined danger button is a separate item.


## factory · plan · 2026-11-23 16:52
### Behaviour
- Preserve sizes, labels, routing and press semantics. Filled primary, danger and highlight controls gain a quiet, crisp edge, theme-aware inner light and restrained elevation. Hover raises subtly; pressing settles without a glowing fill; keyboard focus follows the existing corners.
- Disabled controls retain their pale tokens and no elevation; loading retains its existing soft fill and readable busy beam. Selected foreground/background remain legible. Empty/icon-only faces retain accessibility labels.
- Apply the same treatment to filled CircleButtons, capsule primary and composer ready send. Inspect capsule danger: it is intentionally a pale destructive stop, not a solid destructive fill; preserve that distinction and record why.
- Light/dark tokens must preserve 4.5:1 foreground contrast in all enabled fill states. Respect reduced motion and Android shadow/hit-testing limitations.
### Scope
- Shared filled-control styling and minimal theme tokens, integration points and regression coverage. No new elements, sizes, labels, usage changes, outlined danger restyling, deployment or generated artifacts unless required.
### Decisions
- Existing primary elevation is hard-coded white/light-palette and box-shadow animates; danger/highlight lack elevation. Share a small solid-look helper rather than a new component hierarchy. Prefer token-driven states and instant shadow changes with only existing colour easing and compositor opacity/transform motion.
- Keep outlined/plain unchanged unless an actual adjacent mismatch demands it. Preserve Android's documented no-shadow behavior rather than breaking input dispatch.
- The config mentions nsh 0.5.0 but current AGENTS specifies 0.6.0: use the repository-pinned toolchain, do not downgrade it.
### Checking
- Expand existing theme/button/circle/capsule/composer tests for resting, pressed, focused, selected, disabled and loading states, both palettes and contrast.
- Run gofmt/vet/go test, nsh check, and scripts/test.sh (parallel files, individually retry failures). Inspect gallery and real dialog/Jobs/delete flows at available scales; explicitly report visual/DPR checks unavailable rather than claiming them.

## factory · 2026-11-23 16:52
Built in `4c4febc0` (`feat(console): polish the solid buttons`). Shared theme-aware solid-control finish adds crisp hairlines, restrained inner light/elevation, deeper pressed fills and corner-following keyboard focus to Button primary/danger/highlight, filled CircleButtons, capsule primary and ready composer Send/mic. Added gallery sizes and 10 regression tests; enabled rest/hover/pressed foreground contrast is >=4.5:1 in both palettes. Disabled circles now use pale colours, loading beams remain readable, selected states retained. Shadows change instantly; only existing colour easing remains, respecting reduced motion.

Decisions: capsule danger remains a pale tinted non-destructive stop, intentionally not a solid red action. Android keeps the documented no-shadow tap workaround (also no shadow-based focus ring). Outlined/plain looks unchanged. Used repository-pinned nsh 0.6.0, not the stale 0.5.0 config comment. No installs or manifest changes.

Tests: gofmt, go vet ./..., go test ./... PASS (independently rerun by manager); nsh check PASS (independently rerun); required scripts/test.sh PASS, 162 files, 0 failed, chat-attachments passed the runner's solo retry. Pressed state covered structurally and in Chrome because the headless runner cannot hold a press.

Coder visual checks: Chrome gallery Button/CircleButton/Capsule demos and real Jobs Add, delete confirmation and ready composer Send; both palettes at 1x/1.5x/2x, gallery also 390pt/3x. At 1.5x the inner light anti-aliases and one fractionally-positioned gallery edge blurs. Not checked: real-page primary dialog confirm (scratch Jobs run dialog would not open), Android device/emulator, desktop GPUI (no display). Owner should inspect these, and check solid controls beside FT174 outlined danger; both branches touch ui.tsx/theme.json and may conflict when shipped.
