package com.longbridge.nsh;

/**
 * Pasted images the runtime could not hand to the app (InputBox, patched for FT197): too large to
 * read, or unreadable (the grant to its content URI expired, the provider failed). The app's native
 * part listens and tells the console (`morph.paste.refused`), which says why next to the composer;
 * nothing of the image (its URI, its bytes) is told. Without a listener they are only counted.
 */
public final class PasteNotices {
    private PasteNotices() {}

    public static final String TOO_LARGE = "too_large";
    public static final String BATCH_TOO_LARGE = "batch_too_large";
    public static final String UNREADABLE = "unreadable";

    /** Hears how many images of a paste were refused, and why. */
    public interface Listener {
        void refused(String reason, int count);
    }

    private static volatile Listener listener;

    /** Listens from now on (null: no longer). */
    public static void listen(Listener next) {
        listener = next;
    }

    /** Stops `current` listening, if it still is the listener. */
    public static void stop(Listener current) {
        if (listener == current) listener = null;
    }

    static void refused(String reason, int count) {
        Listener current = listener;
        if (current != null && count > 0) current.refused(reason, count);
    }
}
