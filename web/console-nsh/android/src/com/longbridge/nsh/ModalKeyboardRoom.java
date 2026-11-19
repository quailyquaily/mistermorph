package com.longbridge.nsh;

import android.animation.ValueAnimator;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowInsets;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Takes back the room nsh 0.6.0 leaves under a dialog's scroll view for the software keyboard.
 *
 * <p>nsh draws each dialog (a `Dialog`, a `Sheet`) in a window of its own, which it lays out above
 * the keyboard (`ModalHost` reports its height less the keyboard's): nothing in it is ever under the
 * keyboard. But as the keyboard comes up, `Mounter.keyboard` pads the scroll view around the
 * focused field by how much of it the keyboard covers then, before the window shrinks, and keeps
 * that padding until the keyboard goes down; its reveal then scrolls the field up by it. In the
 * Console's dialogs (a phone paper at the foot of the window) that was an empty band under the
 * fields, the body scrolled into it, and the top of the field cut off under the title.
 *
 * <p>So in a dialog's window, right after each of nsh's keyboard callbacks (the dialog window's and
 * the app window's, both of which call `Mounter.keyboard`) and after each layout of it, the scroll
 * view around the focused field gets no keyboard padding: nsh's reveal, which comes next, then
 * finds the field in sight in the window as it was. Once the window has shrunk above the keyboard
 * (in the second after the keyboard moved, the scroll view's height changes before a frame: nsh
 * places its views itself, outside Android's layout passes), the field is scrolled into what is
 * left of the scroll view, as nsh's reveal does. A scroll by the user changes no height. The app's own window is left to nsh: it does not
 * shrink for the keyboard, and there the padding is what keeps a field in sight.
 *
 * <p>In nsh's package for its package-private parts (the merged classes.dex is one package);
 * compiled against nsh.aar, so a change there fails the build rather than this at run time.
 * Remove it once nsh pads nothing in a window it lays out above the keyboard.
 */
public final class ModalKeyboardRoom {
    private final NshView view;
    /** The dialog windows' decor views already watched (a dialog's window is new each time it opens). */
    private final Set<View> watched = Collections.newSetFromMap(new WeakHashMap<View, Boolean>());
    /** How long after the keyboard moved a dialog's layout brings its focused field into sight. */
    private static final long SETTLE_MS = 1000;
    /** Until when (uptime) the dialogs' layouts bring their focused field into sight. */
    private long revealUntil;

    private ModalKeyboardRoom(NshView view) {
        this.view = view;
    }

    /** Watches the dialogs of `view`'s app. Call once, on the UI thread. */
    public static void install(NshView view) {
        ModalKeyboardRoom room = new ModalKeyboardRoom(view);
        // The app's window calls Mounter.keyboard too (its keyboard inset, with a dialog's field
        // focused): clear right after it, before the reveal it posts.
        view.setOnApplyWindowInsetsListener((v, insets) -> {
            WindowInsets out = v.onApplyWindowInsets(insets);
            room.keyboardMoved(insets);
            room.clearDialogs();
            return out;
        });
        // A dialog that opens takes the focus from the window under it.
        view.getViewTreeObserver().addOnWindowFocusChangeListener(room.focusLost());
    }

    private ViewTreeObserver.OnWindowFocusChangeListener focusLost() {
        return hasFocus -> {
            if (!hasFocus) view.post(this::watchDialogs);
        };
    }

    private void watchDialogs() {
        Mounter mounter = view.mounter();
        if (mounter == null) return;
        for (Window window : mounter.modalWindows()) {
            View decor = window.getDecorView();
            if (!watched.add(decor)) continue;
            // ModalHost's Container, the dialog's content: its onApplyWindowInsets calls
            // Mounter.keyboard. Clear right after it.
            View content = decor.findViewById(android.R.id.content);
            if (content instanceof ViewGroup && ((ViewGroup) content).getChildCount() > 0) {
                ((ViewGroup) content).getChildAt(0).setOnApplyWindowInsetsListener((v, insets) -> {
                    WindowInsets out = v.onApplyWindowInsets(insets);
                    keyboardMoved(insets);
                    clear(decor);
                    return out;
                });
            }
            ViewTreeObserver observer = decor.getViewTreeObserver();
            observer.addOnGlobalLayoutListener(() -> clear(decor));
            // The scroll view's height when last seen before a frame.
            int[] seen = {-1};
            observer.addOnPreDrawListener(() -> {
                if (SystemClock.uptimeMillis() >= revealUntil) return true;
                ScrollBox scroll = clear(decor);
                if (scroll != null && scroll.getHeight() != seen[0]) {
                    seen[0] = scroll.getHeight();
                    reveal(scroll, decor.findFocus());
                }
                return true;
            });
            // A dialog opened over this one.
            observer.addOnWindowFocusChangeListener(focusLost());
        }
    }

    /** The keyboard is up and may have moved: the dialogs' next layouts bring their field into sight. */
    private void keyboardMoved(WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= 30 && !insets.isVisible(WindowInsets.Type.ime())) return;
        revealUntil = SystemClock.uptimeMillis() + SETTLE_MS;
    }

    /** Scrolls `focused` (and 12pt round it) into what `scroll` shows, as nsh's reveal does. */
    private void reveal(ScrollBox scroll, View focused) {
        if (focused == null) return;
        ValueAnimator motion = ValueAnimator.ofFloat(0, 1);
        motion.setDuration(200);
        if (scroll.reveal(focused, Math.round(12 * view.getResources().getDisplayMetrics().density), motion)) motion.start();
    }

    private void clearDialogs() {
        Mounter mounter = view.mounter();
        if (mounter == null) return;
        for (Window window : mounter.modalWindows()) clear(window.getDecorView());
    }

    /**
     * No keyboard padding in the scroll view around the focused field of the dialog window `decor`;
     * that scroll view, or null.
     */
    private static ScrollBox clear(View decor) {
        View focused = decor.findFocus();
        if (focused == null) return null;
        for (ViewParent p = focused.getParent(); p instanceof View && p != decor; p = p.getParent()) {
            if (p instanceof ScrollBox) {
                // setPadding: nothing happens when it has none.
                ((ScrollBox) p).setContentPaddingBottom(0);
                return (ScrollBox) p;
            }
        }
        return null;
    }
}
