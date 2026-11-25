package com.longbridge.nsh;

import java.util.ArrayList;

/**
 * Who keeps a touch that goes down in a scroll view: the decision nsh 0.6.0's {@code ScrollBox.claim}
 * makes for its platform scroll view ({@code VScroll} / {@code HScroll}), with the app's fix for
 * scroll views inside scroll views (see {@code ScrollBox} in this directory). No Android here, so
 * the JDK tests it (android/test/com/longbridge/nsh/ScrollClaimTest.java).
 *
 * <p>The scroll view sees each event before the views inside it. From the down, while it has content
 * to move, it asks the views around not to intercept; the first move past the touch slop decides:
 * along its axis towards content it keeps the drag, otherwise the views around get the rest (a
 * pager's next page) and it ends the touch for everything inside it ({@link #claim} returns true:
 * the caller sends them a cancel). While it keeps the drag, reaching the edge it moves towards hands
 * the rest over the same way.
 *
 * <p>nsh 0.6.0 handed over even when a scroll view inside it could take the drag: a sideways drag on
 * a wide table or code block in the vertical chat, or a vertical drag on the Jobs graph's vertical
 * scroller inside its sideways one, decided "not my axis" in the outer view first, which cancelled
 * the inner view before it saw the move. Now each scroll view that claims a down enlists with the
 * scroll views around it, and one that would hand over first asks them: when one inside takes the
 * drag (it claimed the down and has content to move this way) or already holds it, this one stands
 * aside for the rest of the touch ({@link #standingAside}: it ends nothing and intercepts nothing,
 * so the inner view keeps the drag and, at its own edge, hands the rest to the views around this
 * one, never to this one). With none, it hands over as before.
 */
final class ScrollClaim {
    /** {@code MotionEvent}'s masked actions. */
    static final int DOWN = 0, UP = 1, MOVE = 2, CANCEL = 3;

    /** What the decision needs of its scroll view. */
    interface Host {
        /** Its axis. */
        boolean horizontal();

        /** `scrollable`. */
        boolean enabled();

        /** A JS responder or a pan inside holds the touches ({@code jsBlocked}, {@code gateBlocked}). */
        boolean blocked();

        /** Whether it can scroll along its axis: {@code direction} 1 towards the end, -1 towards the start. */
        boolean canScroll(int direction);

        /** Asks the views around not to intercept the touch (or lets them again). */
        void disallowIntercept(boolean disallow);

        /** The decisions of the scroll views around it (any order). */
        Iterable<ScrollClaim> around();
    }

    private final Host host;
    /** Where the touch went down, and the last move while holding the drag. */
    private float downX, downY, lastX, lastY;
    private long downTime = Long.MIN_VALUE;
    /** Deciding (it had content to move at the down), holding the drag, gave it away, stood aside. */
    private boolean claiming, owning, yielded, aside;
    /** The scroll views inside that claimed the down at {@link #insideDown}. */
    private final ArrayList<ScrollClaim> inside = new ArrayList<>();
    private long insideDown = Long.MIN_VALUE;

    ScrollClaim(Host host) {
        this.host = host;
    }

    /**
     * Before the scroll view dispatches an event ({@code x}, {@code y} in its own coordinates; the
     * touch's down time and slop in px): whether it gives the touch away. It then no longer sees
     * the touch: the caller ends it for the views inside and reports it unhandled.
     */
    boolean claim(int action, float x, float y, long downTime, float slop) {
        if (yielded) {
            if (action == DOWN) yielded = false;
            else {
                if (action == UP || action == CANCEL) {
                    yielded = false;
                    inside.clear();
                }
                return true;
            }
        }
        switch (action) {
            case DOWN:
                this.downTime = downTime;
                downX = x;
                downY = y;
                owning = false;
                aside = false;
                claiming = host.enabled() && !host.blocked() && (host.canScroll(1) || host.canScroll(-1));
                if (claiming) {
                    host.disallowIntercept(true);
                    // The views around saw this down first: they ask this one before they hand over.
                    for (ScrollClaim around : host.around()) around.enlist(this, downTime);
                }
                break;
            case MOVE:
                if (aside) break;
                if (owning) {
                    // Holding the drag: at the edge it moves towards, the rest of the drag goes to
                    // the views around (a pager's next page), unless a scroll view inside holds it.
                    float mx = x - lastX, my = y - lastY;
                    lastX = x;
                    lastY = y;
                    float along = host.horizontal() ? mx : my;
                    if (along != 0 && !host.canScroll(along < 0 ? 1 : -1)) {
                        owning = false;
                        if (insideHolds()) {
                            aside = true;
                            break;
                        }
                        host.disallowIntercept(false);
                        yielded = true;
                        return true;
                    }
                    break;
                }
                if (!claiming) break;
                float dx = x - downX, dy = y - downY;
                if (Math.abs(dx) <= slop && Math.abs(dy) <= slop) break;
                claiming = false;
                if (scrolls(dx, dy)) {
                    owning = true;
                    lastX = x;
                    lastY = y;
                    break;
                }
                if (insideTakes(dx, dy)) {
                    aside = true;
                    break;
                }
                host.disallowIntercept(false);
                yielded = true;
                return true;
            case UP:
            case CANCEL:
                claiming = false;
                owning = false;
                aside = false;
                inside.clear();
                break;
            default:
                break;
        }
        return false;
    }

    /** It stands aside for a scroll view inside until the touch ends: it must not intercept it. */
    boolean standingAside() {
        return aside;
    }

    /** It holds the drag of the touch now. */
    boolean owning() {
        return owning;
    }

    /** Whether a drag by ({@code dx}, {@code dy}) px along its axis has content to move. */
    boolean scrolls(float dx, float dy) {
        if (!host.enabled()) return false;
        if (host.horizontal()) return Math.abs(dx) > Math.abs(dy) && host.canScroll(dx < 0 ? 1 : -1);
        return Math.abs(dy) > Math.abs(dx) && host.canScroll(dy < 0 ? 1 : -1);
    }

    /** A scroll view inside claimed the down at {@code downTime}. */
    private void enlist(ScrollClaim claim, long downTime) {
        if (insideDown != downTime) {
            inside.clear();
            insideDown = downTime;
        }
        if (!inside.contains(claim)) inside.add(claim);
    }

    /**
     * Whether a scroll view inside that claimed this touch's down would keep this drag: it decides on
     * this same move, right after this one (or, scaled inside, decided already and holds it).
     */
    private boolean insideTakes(float dx, float dy) {
        if (insideDown != downTime) return false;
        for (ScrollClaim c : inside) {
            if (c.downTime != downTime) continue;
            if (c.owning || (c.claiming && c.scrolls(dx, dy))) return true;
        }
        return false;
    }

    /** Whether a scroll view inside holds this touch's drag. */
    private boolean insideHolds() {
        if (insideDown != downTime) return false;
        for (ScrollClaim c : inside) {
            if (c.downTime == downTime && c.owning) return true;
        }
        return false;
    }
}
