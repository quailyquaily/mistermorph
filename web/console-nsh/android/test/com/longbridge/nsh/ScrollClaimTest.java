package com.longbridge.nsh;

import java.util.ArrayList;
import java.util.List;

/**
 * Scroll views inside scroll views on Android (ScrollClaim, the touch decision of the app's
 * patched nsh 0.6.0 ScrollBox): who scrolls for a drag in the chat with a wide table or code block,
 * in the Jobs graph's two scrollers, and in a scroll view inside one along the same axis.
 *
 * <p>No Android on the JDK, so the views here are a model of the framework's touch dispatch, as
 * AOSP's ViewGroup, ScrollView and HorizontalScrollView do it: a group sees each event before its
 * children; on a down it clears the touch's targets and its disallow-intercept flag;
 * requestDisallowInterceptTouchEvent sets that flag on the parent and every group above it; a group
 * whose flag is clear asks onInterceptTouchEvent, and one that intercepts sends its target a cancel
 * and takes the rest of the touch in onTouchEvent; a platform scroll view intercepts once the finger
 * is a slop away along its axis from where it last tracked it, and then scrolls by the finger's
 * moves within its content. The scroll views wrap the platform one as ScrollBox's VScroll and
 * HScroll do: ScrollClaim first, and when it gives the touch away a cancel for everything inside and
 * an unhandled event; no interception while it stands aside. Pull to refresh, flings, snapping,
 * nested scrolling (the platform's same-axis chaining), zooming scroll views and multi-touch are
 * left out. This is not Android: it shows the decision and the order of
 * dispatch, which the device check still has to confirm (docs/feat/feat_20261125_android_nested_scroll.md).
 */
public final class ScrollClaimTest {
    static final float SLOP = 8;

    /** A touch event in window coordinates (no view here is moved or scaled). */
    static final class Ev {
        final int action;
        final float x, y;
        final long downTime;

        Ev(int action, float x, float y, long downTime) {
            this.action = action;
            this.x = x;
            this.y = y;
            this.downTime = downTime;
        }

        Ev with(int action) {
            return new Ev(action, x, y, downTime);
        }
    }

    /** A view group (or, as a leaf, a view): ViewGroup's dispatch. */
    static class View {
        final String name;
        View parent, child, target;
        boolean disallow;

        View(String name) {
            this.name = name;
        }

        <T extends View> T add(T c) {
            child = c;
            c.parent = this;
            return c;
        }

        void requestDisallowInterceptTouchEvent(boolean d) {
            disallow = d;
            if (parent != null) parent.requestDisallowInterceptTouchEvent(d);
        }

        boolean onInterceptTouchEvent(Ev e) {
            return false;
        }

        boolean onTouchEvent(Ev e) {
            return false;
        }

        boolean dispatchTouchEvent(Ev e) {
            if (e.action == ScrollClaim.DOWN) {
                target = null;
                disallow = false;
            }
            boolean intercepted;
            if (e.action == ScrollClaim.DOWN || target != null) intercepted = !disallow && onInterceptTouchEvent(e);
            else intercepted = true;
            boolean handled;
            if (!intercepted && e.action == ScrollClaim.DOWN && child != null && child.dispatchTouchEvent(e)) {
                target = child;
                handled = true;
            } else if (target == null) {
                handled = onTouchEvent(e);
            } else if (intercepted) {
                target.dispatchTouchEvent(e.with(ScrollClaim.CANCEL));
                target = null;
                handled = true;
            } else {
                handled = target.dispatchTouchEvent(e);
            }
            if (e.action == ScrollClaim.UP || e.action == ScrollClaim.CANCEL) {
                target = null;
                disallow = false;
            }
            return handled;
        }
    }

    /** Something under the finger that presses (a table cell's text, a Jobs card): it takes the down. */
    static final class Leaf extends View {
        final List<String> heard = new ArrayList<>();

        Leaf(String name) {
            super(name);
        }

        @Override
        boolean dispatchTouchEvent(Ev e) {
            heard.add(e.action == ScrollClaim.DOWN ? "down" : e.action == ScrollClaim.UP ? "up"
                    : e.action == ScrollClaim.CANCEL ? "cancel" : "move");
            return true;
        }

        boolean pressed() {
            return heard.contains("up") && !heard.contains("cancel");
        }

        boolean cancelled() {
            return heard.contains("cancel");
        }
    }

    /** A ScrollBox: its ScrollClaim around a platform scroll view along one axis. */
    static final class Scroll extends View implements ScrollClaim.Host {
        final boolean horizontal;
        final float viewport, content;
        float offset;
        boolean enabled = true;
        final ScrollClaim handoff = new ScrollClaim(this);
        /** Cancels the claim sent into its own views (it gave the touch away). */
        int handedOver;
        // The platform scroll view's drag.
        private boolean dragging;
        private float lastMotion;

        Scroll(String name, boolean horizontal, float viewport, float content, float offset) {
            super(name);
            this.horizontal = horizontal;
            this.viewport = viewport;
            this.content = content;
            this.offset = offset;
        }

        float max() {
            return Math.max(0, content - viewport);
        }

        private float along(Ev e) {
            return horizontal ? e.x : e.y;
        }

        // ScrollClaim.Host
        @Override
        public boolean horizontal() {
            return horizontal;
        }

        @Override
        public boolean enabled() {
            return enabled;
        }

        @Override
        public boolean blocked() {
            return false;
        }

        @Override
        public boolean canScroll(int direction) {
            return direction > 0 ? offset < max() : offset > 0;
        }

        @Override
        public void disallowIntercept(boolean d) {
            if (parent != null) parent.requestDisallowInterceptTouchEvent(d);
        }

        @Override
        public Iterable<ScrollClaim> around() {
            List<ScrollClaim> claims = new ArrayList<>();
            for (View p = parent; p != null; p = p.parent) {
                if (p instanceof Scroll) claims.add(((Scroll) p).handoff);
            }
            return claims;
        }

        // VScroll / HScroll
        @Override
        boolean dispatchTouchEvent(Ev e) {
            if (!handoff.claim(e.action, e.x, e.y, e.downTime, SLOP)) return super.dispatchTouchEvent(e);
            handedOver++;
            super.dispatchTouchEvent(e.with(ScrollClaim.CANCEL));
            return false;
        }

        @Override
        boolean onInterceptTouchEvent(Ev e) {
            if (!enabled || handoff.standingAside()) return false;
            // ScrollView.onInterceptTouchEvent
            switch (e.action) {
                case ScrollClaim.DOWN:
                    lastMotion = along(e);
                    dragging = false;
                    break;
                case ScrollClaim.MOVE:
                    if (dragging) return true;
                    if (Math.abs(along(e) - lastMotion) > SLOP) {
                        dragging = true;
                        lastMotion = along(e);
                        if (parent != null) parent.requestDisallowInterceptTouchEvent(true);
                    }
                    break;
                default:
                    dragging = false;
                    break;
            }
            return dragging;
        }

        @Override
        boolean onTouchEvent(Ev e) {
            if (!enabled) return false;
            // ScrollView.onTouchEvent
            switch (e.action) {
                case ScrollClaim.DOWN:
                    lastMotion = along(e);
                    return true;
                case ScrollClaim.MOVE: {
                    float delta = lastMotion - along(e);
                    if (!dragging && Math.abs(delta) > SLOP) {
                        dragging = true;
                        if (parent != null) parent.requestDisallowInterceptTouchEvent(true);
                        delta += delta > 0 ? -SLOP : SLOP;
                    }
                    if (dragging) {
                        lastMotion = along(e);
                        offset = Math.max(0, Math.min(max(), offset + delta));
                    }
                    return true;
                }
                default:
                    dragging = false;
                    return true;
            }
        }
    }

    /** One finger on the window's root. */
    static final class Finger {
        final View root;
        final long downTime;
        float x, y;

        Finger(View root, float x, float y) {
            this.root = root;
            this.downTime = ++clock;
            this.x = x;
            this.y = y;
            root.dispatchTouchEvent(new Ev(ScrollClaim.DOWN, x, y, downTime));
        }

        /** Moves by ({@code dx}, {@code dy}) in steps of at most 4 px. */
        Finger move(float dx, float dy) {
            int steps = (int) Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 4));
            float sx = dx / steps, sy = dy / steps;
            for (int i = 0; i < steps; i++) {
                x += sx;
                y += sy;
                root.dispatchTouchEvent(new Ev(ScrollClaim.MOVE, x, y, downTime));
            }
            return this;
        }

        void up() {
            root.dispatchTouchEvent(new Ev(ScrollClaim.UP, x, y, downTime));
        }

        /** The system takes the touch (another window, the gesture navigation). */
        void cancel() {
            root.dispatchTouchEvent(new Ev(ScrollClaim.CANCEL, x, y, downTime));
        }
    }

    static long clock;
    static int passed, failed;

    /** The phone's chat with a wide table (or code block) in a reply: root > chat (down) > table (sideways) > cell. */
    static final class Chat {
        final View root = new View("window");
        Scroll pager;
        final Scroll chat, table;
        final Leaf cell = new Leaf("cell");

        Chat(boolean pagerAround, float chatContent, float tableContent, float tableOffset) {
            View top = root;
            if (pagerAround) top = pager = root.add(new Scroll("pager", true, 400, 1200, 400));
            chat = top.add(new Scroll("chat", false, 600, chatContent, chatContent > 600 ? 1200 : 0));
            table = chat.add(new Scroll("table", true, 300, tableContent, tableOffset));
            table.add(cell);
        }

        float chatAt;

        Chat mark() {
            chatAt = chat.offset;
            return this;
        }
    }

    /** The Jobs graph: sideways outside, down inside, a card under the finger. */
    static final class Jobs {
        final View root = new View("window");
        final Scroll x, y;
        final Leaf card = new Leaf("card");

        Jobs(float wide, float tall, float yOffset) {
            x = root.add(new Scroll("todo-flow-scroll-x", true, 400, wide, 0));
            y = x.add(new Scroll("todo-flow-scroll", false, 700, tall, yOffset));
            y.add(card);
        }
    }

    public static void main(String[] args) {
        chatTables();
        chatBoundaries();
        chatTapsAndFreshGestures();
        jobsGraph();
        sameAxis();
        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    static void chatTables() {
        // A sideways drag on a wide table in a long chat scrolls the table, not the chat.
        Chat c = new Chat(false, 3000, 900, 0).mark();
        Finger f = new Finger(c.root, 150, 300).move(-150, 3);
        check("a sideways drag scrolls a wide table in a long chat", c.table.offset > 100, c.table.offset);
        check("...and the chat stays", c.chat.offset == c.chatAt, c.chat.offset);
        check("...the chat gave nothing away (no cancel into the table)", c.chat.handedOver == 0, c.chat.handedOver);
        check("...and stands aside for the rest of the touch", c.chat.handoff.standingAside(), "");
        f.up();
        check("...until the finger lifts", !c.chat.handoff.standingAside(), "");
        check("...and the cell under the finger is not pressed", !c.cell.pressed(), c.cell.heard);

        // In a short chat (nothing to scroll) too.
        c = new Chat(false, 400, 900, 0).mark();
        new Finger(c.root, 150, 300).move(-120, -2).up();
        check("a sideways drag scrolls a wide table in a short chat", c.table.offset > 80, c.table.offset);
        check("...and the short chat stays", c.chat.offset == 0, c.chat.offset);

        // A code block is the same pair of scroll views; it scrolls back towards its start too.
        c = new Chat(false, 3000, 1400, 500).mark();
        new Finger(c.root, 100, 300).move(160, -4).up();
        check("a sideways drag back scrolls a scrolled code block back", c.table.offset < 400, c.table.offset);
        check("...and the chat stays", c.chat.offset == c.chatAt, c.chat.offset);

        // A drag down the table scrolls the chat.
        c = new Chat(false, 3000, 900, 0).mark();
        new Finger(c.root, 150, 400).move(3, -200).up();
        check("a vertical drag on a table scrolls the chat", c.chat.offset > c.chatAt + 150, c.chat.offset);
        check("...and not the table", c.table.offset == 0, c.table.offset);
        check("...the table handed the drag over", c.table.handedOver > 0, c.table.handedOver);

        // A table that fits claims nothing: the chat hands the sideways drag to the views around (as before).
        c = new Chat(true, 3000, 300, 0).mark();
        new Finger(c.root, 150, 300).move(-100, 0).up();
        check("a table that fits scrolls nothing", c.table.offset == 0, c.table.offset);
        check("...the chat hands a sideways drag over it to a pager around", c.chat.handedOver > 0 && c.pager.offset > 400,
                c.pager.offset);
    }

    static void chatBoundaries() {
        // At its start, a table cannot scroll back: the chat hands the drag over as before (a pager's page).
        Chat c = new Chat(true, 3000, 900, 0).mark();
        new Finger(c.root, 150, 300).move(120, 0).up();
        check("a table at its start does not take a drag back", c.table.offset == 0, c.table.offset);
        check("...which goes to the pager around the chat", c.pager.offset < 400, c.pager.offset);
        check("...not to the chat", c.chat.offset == c.chatAt, c.chat.offset);

        // Reaching its end, the table hands the rest of the drag to the pager, never to the chat.
        c = new Chat(true, 3000, 900, 580).mark();
        Finger f = new Finger(c.root, 150, 300).move(-80, 0);
        check("a table scrolls up to its end", c.table.offset == c.table.max(), c.table.offset);
        f.move(-80, 40).up();
        check("...then the rest of the drag goes to the pager around the chat", c.pager.offset > 400, c.pager.offset);
        check("...and a drift down never scrolls the chat", c.chat.offset == c.chatAt, c.chat.offset);

        // The same with nothing around the chat: the drag just ends there.
        c = new Chat(false, 3000, 900, 580).mark();
        new Finger(c.root, 150, 300).move(-80, 0).move(-40, 60).up();
        check("past a table's end with nothing around, nothing else scrolls", c.chat.offset == c.chatAt, c.chat.offset);

        // A sideways drag that turns down stays the table's.
        c = new Chat(false, 3000, 900, 0).mark();
        f = new Finger(c.root, 150, 300).move(-60, 0);
        float tableAt = c.table.offset;
        f.move(0, -200).up();
        check("a sideways drag that turns down keeps to the table", c.chat.offset == c.chatAt, c.chat.offset);
        check("...which only moved sideways", c.table.offset == tableAt, c.table.offset);

        // A drag down that turns sideways stays the chat's.
        c = new Chat(false, 3000, 900, 0).mark();
        f = new Finger(c.root, 150, 400).move(0, -100);
        float chatAt = c.chat.offset;
        f.move(-150, 0).up();
        check("a vertical drag that turns sideways keeps to the chat", c.table.offset == 0, c.table.offset);
        check("...which only moved down", c.chat.offset == chatAt && chatAt > c.chatAt, c.chat.offset);
    }

    static void chatTapsAndFreshGestures() {
        Chat c = new Chat(false, 3000, 900, 0).mark();
        new Finger(c.root, 150, 300).up();
        check("a tap on a table cell presses it", c.cell.pressed(), c.cell.heard);
        c.cell.heard.clear();
        new Finger(c.root, 150, 300).move(5, -5).up();
        check("a tap that wobbles within the slop still presses", c.cell.pressed(), c.cell.heard);
        check("...and scrolls nothing", c.table.offset == 0 && c.chat.offset == c.chatAt, c.table.offset);

        // After a sideways drag, the next drag down scrolls the chat (nothing left standing aside).
        new Finger(c.root, 150, 300).move(-100, 0).up();
        float tableAt = c.table.offset;
        new Finger(c.root, 150, 400).move(0, -150).up();
        check("after a table's drag, a fresh vertical drag scrolls the chat", c.chat.offset > c.chatAt + 100, c.chat.offset);
        check("...and leaves the table", c.table.offset == tableAt, c.table.offset);

        // A touch the system cancels mid-drag leaves nothing behind either.
        c = new Chat(false, 3000, 900, 0).mark();
        new Finger(c.root, 150, 300).move(-50, 0).cancel();
        check("a cancelled drag ends the standing aside", !c.chat.handoff.standingAside(), "");
        tableAt = c.table.offset;
        new Finger(c.root, 150, 300).move(-60, 0).up();
        check("...and the next sideways drag scrolls the table again", c.table.offset > tableAt + 30, c.table.offset);
        c.cell.heard.clear();
        new Finger(c.root, 150, 300).up();
        check("...and the next tap presses", c.cell.pressed(), c.cell.heard);

        // A chat that cannot scroll (`scrollable` off) still lets the table take its drag.
        c = new Chat(false, 3000, 900, 0).mark();
        c.chat.enabled = false;
        new Finger(c.root, 150, 300).move(-100, 0).up();
        check("a table scrolls in a chat that does not scroll", c.table.offset > 60, c.table.offset);
    }

    static void jobsGraph() {
        // A graph wider and taller than the view: both fingers' directions scroll.
        Jobs j = new Jobs(1500, 2000, 0);
        new Finger(j.root, 200, 500).move(2, -200).up();
        check("Jobs: a vertical drag scrolls the graph down", j.y.offset > 150, j.y.offset);
        check("...and not sideways", j.x.offset == 0, j.x.offset);
        check("...the sideways scroller gave nothing away", j.x.handedOver == 0, j.x.handedOver);
        float yAt = j.y.offset;
        new Finger(j.root, 300, 500).move(-200, 3).up();
        check("Jobs: a sideways drag scrolls the graph sideways", j.x.offset > 150, j.x.offset);
        check("...and not down", j.y.offset == yAt, j.y.offset);
        check("...the vertical scroller handed the drag over", j.y.handedOver > 0, j.y.handedOver);
        new Finger(j.root, 200, 500).move(-40, -160).up();
        check("Jobs: a mostly vertical diagonal scrolls down", j.y.offset > yAt + 100, j.y.offset);

        // Cards still press.
        j.card.heard.clear();
        new Finger(j.root, 200, 500).up();
        check("Jobs: a tap presses a card", j.card.pressed(), j.card.heard);
        j.card.heard.clear();
        new Finger(j.root, 200, 500).move(0, -100).up();
        check("Jobs: a card under a drag is not pressed", !j.card.pressed(), j.card.heard);

        // At its foot, the graph has nothing to move up: the drag goes to the views around.
        j = new Jobs(1500, 2000, 1300);
        new Finger(j.root, 200, 500).move(0, -150).up();
        check("Jobs: at its foot a drag up scrolls nothing", j.y.offset == 1300 && j.x.offset == 0, j.y.offset);

        // Scrolled to its foot mid-drag, the rest never turns sideways.
        j = new Jobs(1500, 2000, 1250);
        new Finger(j.root, 200, 500).move(0, -80).move(-80, -40).up();
        check("Jobs: a drag past the foot does not scroll sideways", j.x.offset == 0, j.x.offset);
        check("...after scrolling to the foot", j.y.offset == 1300, j.y.offset);

        // Only taller: the sideways scroller claims nothing.
        j = new Jobs(400, 2000, 0);
        new Finger(j.root, 200, 500).move(0, -200).up();
        check("Jobs: a narrow graph scrolls down", j.y.offset > 150, j.y.offset);
        // Only wider: a sideways drag scrolls it.
        j = new Jobs(1500, 700, 0);
        new Finger(j.root, 300, 500).move(-200, 0).up();
        check("Jobs: a short graph scrolls sideways", j.x.offset > 150, j.x.offset);
    }

    static void sameAxis() {
        // A list at its foot with a scroll view inside that can still move: the inner one scrolls
        // (nsh 0.6.0 cancelled it, as the outer one had nothing to move).
        View root = new View("window");
        Scroll page = root.add(new Scroll("page", false, 600, 2000, 1400));
        Scroll inner = page.add(new Scroll("inner", false, 300, 1000, 200));
        Leaf leaf = inner.add(new Leaf("row"));
        new Finger(root, 100, 400).move(0, -150).up();
        check("same axis: an inner scroll view scrolls under a page at its foot", inner.offset > 300, inner.offset);
        check("...and the page stays", page.offset == 1400, page.offset);

        // With room in both, the inner one scrolls first and the page takes the rest at its end (as before).
        page = root.add(new Scroll("page", false, 600, 2000, 600));
        inner = page.add(new Scroll("inner", false, 300, 1000, 650));
        inner.add(leaf);
        new Finger(root, 100, 500).move(0, -200).up();
        check("same axis: the inner scroll view scrolls to its end first", inner.offset == inner.max(), inner.offset);
        check("...then the page scrolls on", page.offset > 600, page.offset);

        // A drag that turns back while the inner one holds it stays with the inner one.
        page = root.add(new Scroll("page", false, 600, 2000, 1400));
        inner = page.add(new Scroll("inner", false, 300, 1000, 400));
        inner.add(leaf);
        new Finger(root, 100, 300).move(0, 100).move(0, -150).up();
        check("same axis: an inner drag that turns back is still the inner one's", inner.offset > 400, inner.offset);
        check("...and the page at its foot was not cancelled into", page.handedOver == 0, page.handedOver);
    }

    static void check(String what, boolean ok, Object got) {
        if (ok) {
            passed++;
            System.out.println("ok   " + what);
        } else {
            failed++;
            System.out.println("FAIL " + what + " (got " + got + ")");
        }
    }
}
