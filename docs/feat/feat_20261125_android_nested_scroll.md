---
date: 2026-11-25
title: Scroll views inside scroll views in the Android app
status: implemented (device check pending)
---

# Scroll views inside scroll views in the Android app

## Problem

In the Android app, a wide Markdown table or a wide code block in a reply could not be dragged
sideways, though both scroll sideways in a phone's browser. The Jobs dependency graph (TODO flow:
a sideways scroller around a vertical one, `components/todo/TodoFlow.tsx`) had the same trouble the
other way round: once the graph was wider than the screen, a vertical drag on it scrolled nothing.

The Console's views are right (`ChatMarkdown.tsx`: each table and code block sits in its own
`<Scroll horizontal>`). The cause is in nsh 0.6.0's Android runtime.

## Cause

nsh draws every `Scroll` on Android with `ScrollBox`
(`crates/nsh-platform-android/java/com/longbridge/nsh/ScrollBox.java`): a frame around a platform
`ScrollView` (`VScroll`) or `HorizontalScrollView` (`HScroll`). Before either platform view
dispatches an event, `ScrollBox.claim` decides who keeps the touch. From the down, a scroll view with
content to move asks the views around it not to intercept; the first move past the touch slop
decides: along its axis towards content it keeps the drag; otherwise it lets the views around
intercept again (`yielded`) and its `dispatchTouchEvent` sends `ACTION_CANCEL` into everything
inside it. That hand-over is meant for a pager around the scroll view.

Android dispatches a touch from the outside in, so the outer scroll view decides first, before the
scroll view inside it sees the move. For a sideways drag on a table in the chat:

1. Down: the chat (`VScroll`, with content to move) and the table (`HScroll`, wider than the reply)
   both claim it.
2. First move past the slop: the chat decides first. The drag is not along its axis, so it hands
   over, and its `dispatchTouchEvent` cancels everything inside it: the table.
3. The table sees only the cancel; nothing around the chat takes the drag either. Nothing scrolls.

A chat too short to scroll claims nothing at the down, so there the table did scroll. The Jobs
graph is the same pair the other way round: once the graph is wider than the view, its sideways
scroller cancels the vertical one on every vertical drag. And a scroll view inside one along the
same axis was cancelled whenever the outer one sat at the edge the drag moves towards.

This was read from the pinned source and reproduced in a model of Android's dispatch (below); it
has not been seen on a device by this change's author.

## Fix

The app's native part replaces nsh 0.6.0's `ScrollBox` with a patched copy
(`web/console-nsh/android/src/com/longbridge/nsh/ScrollBox.java`) and moves the decision, unchanged
but for the fix, to `ScrollClaim.java` beside it (no Android in it, so the JDK tests it):

- A scroll view that claims a down enlists with the scroll views around it.
- One that would hand the drag over (the first move is not along its axis or has nothing to move
  that way; or, holding it, it reached its edge) first asks the scroll views inside that claimed the
  same down. When one would keep this drag (it has content to move this way) or already holds it,
  the outer one stands aside for the rest of the touch: it sends no cancel, does not intercept, and
  leaves the disallow-intercept flags as they are. The inner scroll view takes the drag as it would
  on its own.
- With none, it hands over as before (a pager around still gets its pages).
- Standing aside ends with the touch (up or cancel); the next touch decides afresh.

So:

- A sideways drag on a wide table or code block scrolls it, in a short or a long chat; a vertical
  drag on it still scrolls the chat (the table hands that drag over, as before). The reply keeps its
  width: nothing about layout changed.
- At its end, a table hands the rest of a sideways drag to the views around the chat (a pager),
  never to the chat: a drift of the finger does not start the chat scrolling under the table.
- A drag keeps the axis it started on: sideways on a table then down moves nothing more; down on
  the chat then sideways keeps to the chat.
- A table, code block or graph that fits (nothing to scroll) claims nothing, as before.
- Taps press as before: the decision happens only past the slop. A drag still cancels the press
  under it (the scroll view that takes the drag cancels it, as Android's scroll views do).
- The Jobs graph scrolls both ways when it overflows both ways; a drag past its foot does not turn
  sideways.
- Desktop and browser builds are untouched: this is Android-only Java.

## How it is built in

`scripts/android-host.sh dex` (run by `scripts/build-android.sh`) builds the APK's `classes.dex`
from the runtime's and the app's classes. The patched class has the same name as the runtime's, so
the script first splits the runtime's `classes.dex` into one dex per class (`d8 --file-per-class`),
leaves out `com/longbridge/nsh/ScrollBox.dex` and its nested and synthetic classes, and merges the
rest with the app's classes. It fails clearly:

- for any nsh version but 0.6.0 (`build-android.sh` passes `nsh --version`'s), so an nsh update
  makes whoever updates it check whether nsh fixed this, then drop the copy or redo the patch;
- when the runtime has no `ScrollBox`, or has a nested `ScrollBox` class the copy lacks (a runtime
  that is not 0.6.0's).

Provenance: the copy starts from `ScrollBox.java` of nsh 0.6.0, SHA-256
`e80365d5c214382ab38f3e162770dc5c04d7be7beb00fc91d363e3467b339d80`, the same file in the crates.io
`nsh-platform-android` 0.6.0 package and in the v0.6.0 source archive (`longbridge-nsh-9264c6f`).
The CLI used here reports `nsh 0.6.0 (5541637)`. To see the patch:

```bash
diff -u ~/.cargo/registry/src/*/nsh-platform-android-0.6.0/java/com/longbridge/nsh/ScrollBox.java \
  web/console-nsh/android/src/com/longbridge/nsh/ScrollBox.java
```

It changes the header comment, `claim` (now a call into `ScrollClaim`, with its state there) and the
two `onInterceptTouchEvent`s (no interception while standing aside). nsh is Apache-2.0; the copy
says where it comes from and that it was changed.

`ZScroll` (a zooming scroll view) has its own decision, which never cancels the views inside, and
is not changed; it does not enlist either. The Console has no zooming scroll views.

## Tests

`web/console-nsh/scripts/android-host.sh test` runs `android/test/com/longbridge/nsh/ScrollClaimTest.java`
on the JDK. It drives the real `ScrollClaim` through a model of Android's touch dispatch, written
after AOSP's `ViewGroup`, `ScrollView` and `HorizontalScrollView` (disallow-intercept flags cleared
on each down and set up the parent chain; a group asks `onInterceptTouchEvent` only while its flag
is clear, then cancels its target and takes the touch; a platform scroll view intercepts once the
finger is a slop away along its axis, then scrolls within its content), with `ScrollBox`'s glue
around it. Cases: the chat with a table or code block (long and short chats, back towards the
start, a vertical drag, a table that fits, a pager around), boundaries (a table at its start, at
its end with and without a pager, a drift after the end), direction changes both ways, taps (still
and within the slop), a fresh drag after a drag and after a system cancel, a chat that does not
scroll, the Jobs graph (vertical, sideways, diagonal, a card's tap and drag, its foot, only wider,
only taller) and same-axis nesting. Run against the decision without the fix (both checks of the
views inside turned off) 13 of its 55 checks fail: the table, the code block, the Jobs graph's
vertical drag and the same-axis inner scroll view do not scroll, and the outer view cancels into
the inner one.

The model leaves out pull to refresh, flings, snapping, nested scrolling (the platform's same-axis
chaining), view transforms and multi-touch.

## Not checked

- On a device or emulator. None was available when this was written, nor the Android SDK, nsh
  0.6.0's prebuilt Android runtime or its `nsh.aar`, so neither the APK build nor the app ran. What
  did run: `android-host.sh dex` with D8 from R8 8.5.35 (Google Maven) on a stand-in runtime
  compiled from the 0.6.0 Java sources against Android 15's framework classes (Robolectric's
  `android-all` 15); the patched classes compile, the merge keeps every runtime class and the
  `ScrollBox` classes in the result are the patched ones. The prebuilt runtime's dex itself was not
  split.
- Text selection inside a code block or table (the model has none). A long press there disallows
  interception; a vertical drag of the selection afterwards still lets the inner scroll view hand
  the drag over (unchanged nsh behaviour), so the chat may take it.

Check on a phone, in the app built by `scripts/build-android.sh`: in a short and in a long chat, a
reply with a wide table and one with a wide code block (drag each sideways both ways, to its ends
and past them, then down; drag down on them to scroll the chat; tap a link in a table cell; press
the code block's copy; long-press to select text); the Jobs page with a graph wider and taller than
the screen (drag both ways and diagonally, tap a card, drag from a card, drag past each edge).
