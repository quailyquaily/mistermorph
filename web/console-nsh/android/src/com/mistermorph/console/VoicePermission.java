package com.mistermorph.console;

/** What asking for the microphone came to. */
final class VoicePermission {
    private VoicePermission() {}

    enum Outcome {
        /** The app may record. */
        GRANTED,
        /** Refused this time; the system asks again on the next try. */
        DENIED,
        /** Refused for good ("Don't ask again", or denied twice): only the system's Settings can allow it. */
        BLOCKED,
    }

    /**
     * Reads Android's answer. {@code rationaleBefore} and {@code rationaleAfter} are
     * {@code shouldShowRequestPermissionRationale} before and after the request, {@code askedBefore}
     * whether the app asked in an earlier request. The system asks again only while it would show a
     * rationale; once it would not after a refusal the user (or the system, after a second refusal)
     * blocked it, unless this was the first request, which the user may only have dismissed.
     */
    static Outcome decide(boolean granted, boolean rationaleBefore, boolean rationaleAfter, boolean askedBefore) {
        if (granted) return Outcome.GRANTED;
        if (rationaleAfter) return Outcome.DENIED;
        if (rationaleBefore || askedBefore) return Outcome.BLOCKED;
        return Outcome.DENIED;
    }
}
