package com.mistermorph.console;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The phone app's microphone, behind the console's `morph.voice.*` host calls (lib/mobileHost.ts):
 * one recording at a time, kept as an AAC file in the app's cache until it is uploaded to the
 * agent's /voice/transcribe or thrown away.
 *
 * <ul>
 *   <li>{@code start} asks for the microphone the first time (and after a refusal), then records;
 *   it answers {@code {ok}} or {@code {ok: false, error}} with {@code permission-denied},
 *   {@code permission-blocked}, {@code no_mic}, {@code busy} or {@code cancelled}.</li>
 *   <li>{@code stop} releases the microphone and answers the recording as a file
 *   ({@code {id, name, size, type}}), or null when it holds no audio.</li>
 *   <li>{@code upload} sends a stopped recording; the file goes once it was sent, and with
 *   {@code release}.</li>
 *   <li>{@code cancel}, the app leaving the foreground ({@link #background}) and the activity going
 *   ({@link #close}) end everything: a pending start answers {@code cancelled}, the microphone is
 *   released, uploads are aborted and every recording is deleted. Leaving the foreground also tells
 *   the app ({@code morph.voice.ended}, {@code reason: "background"}), as a recorder failure does
 *   ({@code reason: "error"}).</li>
 * </ul>
 *
 * Its methods run on the UI thread, except the end of an upload; they are synchronized.
 */
final class VoiceController {
    static final String ENDED_EVENT = "morph.voice.ended";
    static final String FILE_NAME = "voice.m4a";
    static final String FILE_TYPE = "audio/mp4";

    /** How a host call is answered: NshHostReply on Android. */
    interface Reply {
        void resolve(Object value);

        void reject(String message);
    }

    private final VoicePlatform platform;
    // Bumped by every start, stop and discard: a permission answer or a recorder error of an older
    // recording is stale.
    private int generation;
    private Reply pendingStart;
    private VoicePlatform.Recording recording;
    private File recordingFile;
    private final Map<String, File> files = new HashMap<>();
    private final Map<String, MultipartUpload> uploads = new HashMap<>();
    private int nextID;
    private boolean foreground = true;
    private boolean closed;

    VoiceController(VoicePlatform platform) {
        this.platform = platform;
    }

    /** Why the app cannot record here: "" when it can, "no_mic" without a microphone. */
    synchronized String support() {
        return platform.hasMicrophone() ? "" : "no_mic";
    }

    synchronized void start(Reply reply) {
        if (closed || !foreground) {
            reply.resolve(failure("cancelled", ""));
            return;
        }
        if (pendingStart != null || recording != null) {
            reply.resolve(failure("busy", "A recording is already under way."));
            return;
        }
        if (!platform.hasMicrophone()) {
            reply.resolve(failure("no_mic", ""));
            return;
        }
        if (platform.hasPermission()) {
            begin(reply);
            return;
        }
        final int token = ++generation;
        pendingStart = reply;
        platform.requestPermission(outcome -> permissionAnswered(token, outcome));
    }

    private synchronized void permissionAnswered(int token, VoicePermission.Outcome outcome) {
        // Cancelled (or backgrounded) while the system asked: that already answered the start.
        if (token != generation || pendingStart == null) return;
        Reply reply = pendingStart;
        pendingStart = null;
        if (outcome == VoicePermission.Outcome.BLOCKED) {
            reply.resolve(failure("permission-blocked", ""));
        } else if (outcome != VoicePermission.Outcome.GRANTED) {
            reply.resolve(failure("permission-denied", ""));
        } else if (closed || !foreground) {
            reply.resolve(failure("cancelled", ""));
        } else {
            begin(reply);
        }
    }

    private void begin(Reply reply) {
        final int token = ++generation;
        File file = null;
        try {
            file = platform.createRecordingFile();
            recording = platform.startRecording(file, message -> recorderFailed(token, message));
            recordingFile = file;
            reply.resolve(success());
        } catch (Exception e) {
            recording = null;
            recordingFile = null;
            delete(file);
            reply.resolve(failure("busy", message(e)));
        }
    }

    private synchronized void recorderFailed(int token, String message) {
        if (token != generation || recording == null) return;
        discardRecording();
        generation++;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("reason", "error");
        data.put("message", message == null ? "" : message);
        platform.send(ENDED_EVENT, data);
    }

    synchronized void stop(Reply reply) {
        if (recording == null) {
            reply.resolve(null);
            return;
        }
        VoicePlatform.Recording current = recording;
        File file = recordingFile;
        recording = null;
        recordingFile = null;
        generation++;
        boolean kept;
        try {
            kept = current.stop();
        } catch (RuntimeException e) {
            kept = false;
        } finally {
            current.release();
        }
        if (!kept || file == null || file.length() == 0) {
            delete(file);
            reply.resolve(null);
            return;
        }
        String id = "voice-" + (++nextID);
        files.put(id, file);
        Map<String, Object> picked = new LinkedHashMap<>();
        picked.put("id", id);
        picked.put("name", FILE_NAME);
        picked.put("size", file.length());
        picked.put("type", FILE_TYPE);
        picked.put("preview", "");
        reply.resolve(picked);
    }

    synchronized void upload(Map<?, ?> args, final Reply reply) {
        final String id = MultipartUpload.text(args.get("id"));
        File file = files.get(id);
        if (file == null || uploads.containsKey(id)) {
            reply.reject("The recording is no longer available.");
            return;
        }
        final MultipartUpload upload;
        try {
            upload = MultipartUpload.from(args, file, FILE_NAME, FILE_TYPE);
        } catch (Exception e) {
            finished(id);
            reply.reject(message(e));
            return;
        }
        uploads.put(id, upload);
        try {
            platform.runInBackground(() -> {
                try {
                    MultipartUpload.Result result = upload.send();
                    reply.resolve(result.toMap());
                } catch (Exception e) {
                    reply.reject(upload.aborted() ? "The recording was discarded." : message(e));
                } finally {
                    finished(id);
                }
            });
        } catch (RuntimeException e) {
            finished(id);
            reply.reject(message(e));
        }
    }

    /** Sent or not, a recording goes once its upload ended. */
    private synchronized void finished(String id) {
        uploads.remove(id);
        delete(files.remove(id));
    }

    synchronized void release(String id) {
        MultipartUpload upload = uploads.remove(id);
        if (upload != null) upload.abort();
        delete(files.remove(id));
    }

    /** The app threw the recording away: nothing to tell it. */
    synchronized void cancel() {
        discard(null);
    }

    /** The activity is visible again. */
    synchronized void foreground() {
        foreground = true;
    }

    /** The activity is no longer visible: no recording in the background. */
    synchronized void background() {
        foreground = false;
        discard("background");
    }

    /** The activity is gone. */
    synchronized void close() {
        closed = true;
        discard(null);
    }

    /** Whether anything holds the microphone or a recording (tests). */
    synchronized boolean idle() {
        return pendingStart == null && recording == null && files.isEmpty() && uploads.isEmpty();
    }

    private void discard(String reason) {
        generation++;
        boolean active = false;
        if (pendingStart != null) {
            Reply reply = pendingStart;
            pendingStart = null;
            reply.resolve(failure("cancelled", ""));
            active = true;
        }
        if (recording != null) {
            discardRecording();
            active = true;
        }
        List<MultipartUpload> running = new ArrayList<>(uploads.values());
        uploads.clear();
        for (MultipartUpload upload : running) {
            upload.abort();
            active = true;
        }
        if (!files.isEmpty()) active = true;
        for (File file : files.values()) delete(file);
        files.clear();
        if (reason != null && active) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("reason", reason);
            platform.send(ENDED_EVENT, data);
        }
    }

    private void discardRecording() {
        VoicePlatform.Recording current = recording;
        File file = recordingFile;
        recording = null;
        recordingFile = null;
        try {
            current.stop();
        } catch (RuntimeException ignored) {
            // Nothing recorded yet, or the recorder already failed: it is released below anyway.
        } finally {
            current.release();
        }
        delete(file);
    }

    private static void delete(File file) {
        if (file != null && file.exists() && !file.delete()) file.deleteOnExit();
    }

    private static Map<String, Object> success() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ok", true);
        return map;
    }

    private static Map<String, Object> failure(String error, String message) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ok", false);
        map.put("error", error);
        if (message != null && !message.isEmpty()) map.put("message", message);
        return map;
    }

    private static String message(Throwable e) {
        String message = e.getMessage();
        return message == null || message.trim().isEmpty() ? e.getClass().getSimpleName() : message.trim();
    }
}
