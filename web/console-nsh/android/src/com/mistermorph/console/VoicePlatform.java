package com.mistermorph.console;

import java.io.File;
import java.io.IOException;
import java.util.Map;

/**
 * What a voice recording needs from the system: Android's in {@link AndroidVoicePlatform}, a fake
 * one in the JVM tests. {@link VoiceController} calls it on the UI thread.
 */
interface VoicePlatform {
    /** Whether the device has a microphone at all. */
    boolean hasMicrophone();

    /** Whether the app may record audio now. */
    boolean hasPermission();

    /** Asks the user for the microphone; {@code callback} hears the outcome once, on the UI thread. */
    void requestPermission(PermissionCallback callback);

    /** A new, empty file in the app's private cache for one recording. */
    File createRecordingFile() throws IOException;

    /**
     * Opens the microphone and records into {@code file}. Throws when the microphone cannot be
     * opened (another app holds it, the recorder refuses its settings); then nothing is held.
     * {@code onError} hears a failure after it started.
     */
    Recording startRecording(File file, RecordingErrorListener onError) throws Exception;

    /** Sends event {@code name} to the app (its {@code host.on(name, ...)}). */
    void send(String name, Map<String, Object> data);

    /** Runs {@code task} off the UI thread (uploads). */
    void runInBackground(Runnable task);

    /** A recording under way. */
    interface Recording {
        /** Stops recording; false when it holds no audio (stopped at once, or the recorder failed). */
        boolean stop();

        /** Releases the microphone and the recorder; called once, after {@link #stop} or instead of it. */
        void release();
    }

    interface PermissionCallback {
        void done(VoicePermission.Outcome outcome);
    }

    interface RecordingErrorListener {
        void failed(String message);
    }
}
