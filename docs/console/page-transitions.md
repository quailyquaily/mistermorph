# Page transitions

How the Console (`web/console-nsh`) moves from one page to the next (FT93): which way each
navigation moves, what draws it, what happens to the page going out, and what was checked.

## Behaviour

On phones (the bottom-navigation layout, at most 980 points wide):

- **Further in** (a topic, a settings section, a memory subject, an audit log, a skill, a TODO, a
  contact, the context inspector and its steps, Settings → System → Logs, the skill store): the new
  page slides in from the right over the old one, which drifts a third of the width to the left.
- **Back** (the bar's back arrow, Android's Back button or edge swipe, the browser's back button):
  the reverse. The page going out slides out to the right over the page it reveals.
- **Bottom navigation** (the bar and More): the two pages move together, side by side, as tiles of
  a horizontal strip in the navigation's order (Chat, Contacts, TODO, Memories, Skills, Stats,
  Audit, Settings): to a later page the strip moves left, to an earlier one right. History steps
  between them replay the step reversed (back) or again (forward).
- **No motion**: the first page of a run (also after a reload, and for the redirects that lead to
  it), the same page with other data (another topic opened from the topic list's page, another
  agent's copy of the page), the item a page arrives with (an address naming a settings section,
  a skill or a contact, opened within half a second of the page appearing: the page itself already
  slid in), and every navigation when the system asks for reduced motion.
- **The frame changes** (login, setup, the overview of all agents): the new page settles in as it
  did before (6 points up, fading in).

Wide windows (the sidebar layout) keep the Console's page entrance: a new top-level page rises 6
points into place as it fades in; the old page goes at once. Their list and detail stand side by
side, so nothing slides.

Only navigations that commit move a page. A navigation whose guard is still running (the session
check, a settings page's unsaved-changes question) moves nothing; one the guard cancels moves
nothing at all. Swipe gestures are not part of this.

## How it is built

- `lib/navMotion.ts` decides which way a navigation moves, from where both pages sit in the
  navigation (`navPosition`: the navigation's page, the depth below it, the frame), and keeps the
  run's history with each step's motion (`MotionHistory`) so a history step replays it. Pure.
- `lib/router.ts` records each committed navigation (`navigation()`: from, to, push / replace /
  history step, motion) in the same batch as the route. The navigation's own controls pass
  `tab: true` (`lib/shell.ts` `goTo`); the order is `lib/navOrder.ts`.
- `components/frame/PageStack.tsx` is the page host (`pages/routes.tsx` `PageView`): a layer per
  page instance, and the slide between two of them (`components/motion/pageSlide.ts`). The frame
  around it (sidebar, bottom navigation, banners, notices) is outside and never moves.
- `components/motion/PaneStack.tsx` is the same slide for pages that switch between a list and one
  of its items within one page instance on phones. The page host sees no new page there; each such
  page moves its own panes (Chat, Settings, Memories, Audit, Skills, TODO, Contacts, the context
  inspector). Their phone bars that belong to the item (Chat's, TODO's, the knowledge pages'
  `MobileBar`) are inside the item's pane, so they move with it.

Only `translateX` moves, natively; slides take 280 ms on the Console's easing curve.

## The page going out

- It stays mounted until its slide has ended, under or over the new page, then goes.
- It is inert: it takes no presses (`pointerEvents: "none"`), is hidden from assistive tech
  (`accessibilityElementsHidden`, `importantForAccessibility="no-hide-descendants"`, `aria-hidden`
  on the web), and a text field in it loses the focus (and the phone's keyboard goes down) as the
  slide starts. Android's Back registered by a pane going out no longer applies.
- It never reacts to the next page's route: pages read their route with `currentRoute()`, which
  inside a page is that page instance's own (`PageRouteContext`), frozen once it goes out. Pages
  whose item clears with the route (Skills' `?skill=`, the context inspector's steps, a deleted
  contact) show it through `PaneStack.held`, and Chat lets its topic go only once the conversation
  has slid out (the topic list comes back at once).
- A new navigation during a slide drops the obsolete outgoing page at once; the page that was
  coming in turns round from where it is (no jump). A resize, a rotation, a switch between the
  phone and wide layouts, or reduced motion turned on ends a running slide where it ends.
- Dialogs and sheets (`Modal`, `MessageDialog`, the bottom sheets, the phone's workspace sheet) are
  not pages: they keep their own motion and are never moved by this.

## Checks

- Headless (`nsh test`): `tests/nav-motion.test.tsx` (directions, navigation order, history
  replay, presentation, slide geometry), `tests/page-stack.test.tsx` and `tests/pane-stack.test.tsx`
  (fixtures whose slide driver holds every slide part-way: both pages during a slide, the outgoing
  page inert with its own route, rapid switches, resize, reduced motion, wide windows),
  `tests/page-transitions.test.tsx` (the real Console: bottom navigation and Android's Back, a page
  further in and back, the browser's back and forward buttons, rapid taps, reduced motion, the wide
  entrance, a chat topic in and out, a cancelled leave).
- Headless steps do not wait for a slide on the system clock: a test that checks a page has gone
  right after a navigation waits for it (`app.waitFor(sel, { state: "gone" })`).
- Chrome (the real Console served by `console serve`, Playwright, 390×844 touch and 1280×800):
  the layers' and panes' positions sampled every frame through each kind of navigation, mid-slide
  screenshots, a settings section left through the bottom navigation (the leaving Settings page
  kept its own section and did not navigate), rapid taps and a rotation mid-slide, taps on the next
  topic 0–400 ms after Back, reduced motion, and before/after screenshots of nine pages on both
  layouts (identical but for clock text).
- Not checked: an Android device or emulator (none on the build machine) and the desktop app's
  GPUI window (no display); both run the same code, the Android app only the phone layout.
