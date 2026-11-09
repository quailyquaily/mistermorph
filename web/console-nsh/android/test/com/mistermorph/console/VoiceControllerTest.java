package com.mistermorph.console;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The phone app's recorder without Android: {@link VoiceController} on a fake platform, the
 * permission outcomes and the upload against a local HTTP server. Plain Java (no test framework):
 * scripts/android-host.sh test compiles and runs it on the JDK.
 */
public final class VoiceControllerTest {
    private static int passed;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        File dir = Files.createTempDirectory("morph-voice-test").toFile();
        try {
            run("permission outcomes", VoiceControllerTest::permissionOutcomes);
            run("support says whether there is a microphone", () -> support(dir));
            run("granted: records, stops, uploads, deletes", () -> recordAndUpload(dir));
            run("first use asks, then records", () -> firstUseAsks(dir));
            run("denied and blocked say so and record nothing", () -> deniedAndBlocked(dir));
            run("cancel while asking drops a late grant", () -> cancelWhileAsking(dir));
            run("leaving the app ends the recording and tells the app", () -> background(dir));
            run("leaving the app while asking answers cancelled", () -> backgroundWhileAsking(dir));
            run("a recording without audio is no file", () -> emptyRecording(dir));
            run("a busy microphone holds nothing", () -> busyMicrophone(dir));
            run("a recorder error ends it; a stale one is ignored", () -> recorderError(dir));
            run("cancel aborts an upload and deletes the file", () -> cancelUpload(dir));
            run("release and close delete what is left", () -> releaseAndClose(dir));
            run("an upload without a field sends the file as the body", () -> rawUpload(dir));
            run("an HTTP error comes back as the answer", () -> httpError(dir));
        } finally {
            File[] left = dir.listFiles();
            if (left != null) for (File file : left) file.delete();
            dir.delete();
        }
        System.out.println(passed + " passed, " + failures.size() + " failed");
        for (String failure : failures) System.out.println("FAIL " + failure);
        if (!failures.isEmpty()) System.exit(1);
    }

    interface Body {
        void run() throws Exception;
    }

    private static void run(String name, Body body) {
        try {
            body.run();
            passed++;
            System.out.println("ok   " + name);
        } catch (Throwable e) {
            failures.add(name + ": " + e);
            System.out.println("FAIL " + name + ": " + e);
        }
    }

    private static void check(boolean condition, String what) {
        if (!condition) throw new AssertionError(what);
    }

    private static void equal(Object actual, Object expected, String what) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(what + ": expected <" + expected + "> but was <" + actual + ">");
        }
    }

    /* ---------- fakes ---------- */

    static final class FakeRecording implements VoicePlatform.Recording {
        final File file;
        final VoicePlatform.RecordingErrorListener onError;
        boolean stopped;
        boolean released;
        boolean audio = true;

        FakeRecording(File file, VoicePlatform.RecordingErrorListener onError) {
            this.file = file;
            this.onError = onError;
        }

        @Override
        public boolean stop() {
            check(!released, "stopped after release");
            stopped = true;
            return audio;
        }

        @Override
        public void release() {
            check(!released, "released twice");
            released = true;
        }
    }

    static final class FakePlatform implements VoicePlatform {
        final File dir;
        boolean microphone = true;
        boolean permission = true;
        boolean busy;
        boolean writeAudio = true;
        final List<PermissionCallback> asked = new ArrayList<>();
        final List<FakeRecording> recordings = new ArrayList<>();
        final List<String> events = new ArrayList<>();
        final List<Thread> background = new ArrayList<>();

        FakePlatform(File dir) {
            this.dir = dir;
        }

        @Override
        public boolean hasMicrophone() {
            return microphone;
        }

        @Override
        public boolean hasPermission() {
            return permission;
        }

        @Override
        public void requestPermission(PermissionCallback callback) {
            asked.add(callback);
        }

        @Override
        public File createRecordingFile() throws IOException {
            return File.createTempFile("voice-", ".m4a", dir);
        }

        @Override
        public Recording startRecording(File file, RecordingErrorListener onError) throws Exception {
            if (busy) throw new IllegalStateException("start failed");
            if (writeAudio) {
                try (OutputStream out = new FileOutputStream(file)) {
                    out.write("fake aac audio".getBytes(StandardCharsets.UTF_8));
                }
            }
            FakeRecording recording = new FakeRecording(file, onError);
            recordings.add(recording);
            return recording;
        }

        @Override
        public void send(String name, Map<String, Object> data) {
            events.add(name + " " + data);
        }

        @Override
        public void runInBackground(Runnable task) {
            Thread thread = new Thread(task);
            background.add(thread);
            thread.start();
        }

        FakeRecording last() {
            return recordings.get(recordings.size() - 1);
        }

        void join() throws InterruptedException {
            for (Thread thread : background) thread.join(10_000);
        }

        int files() {
            String[] names = dir.list();
            return names == null ? 0 : names.length;
        }
    }

    static final class Answer implements VoiceController.Reply {
        final CountDownLatch done = new CountDownLatch(1);
        volatile Object value;
        volatile String error;
        volatile int answers;

        @Override
        public void resolve(Object value) {
            this.value = value;
            answers++;
            done.countDown();
        }

        @Override
        public void reject(String message) {
            this.error = message;
            answers++;
            done.countDown();
        }

        Answer await() throws InterruptedException {
            check(done.await(10, TimeUnit.SECONDS), "no answer");
            return this;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> map() {
            return (Map<String, Object>) value;
        }
    }

    /** A local server: each request's headers and body, answered with {@code status} and {@code body}. */
    static final class Server implements AutoCloseable {
        final HttpServer http;
        final List<Map<String, String>> headers = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();
        volatile int status = 200;
        volatile String body = "{\"text\":\"book a table\"}";
        volatile CountDownLatch hold;
        final CountDownLatch received = new CountDownLatch(1);

        Server() throws IOException {
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            http.createContext("/", exchange -> {
                Map<String, String> seen = new LinkedHashMap<>();
                exchange.getRequestHeaders().forEach((key, values) -> seen.put(key.toLowerCase(), String.join(",", values)));
                seen.put(":method", exchange.getRequestMethod());
                headers.add(seen);
                bodies.add(new String(readAll(exchange.getRequestBody()), StandardCharsets.ISO_8859_1));
                received.countDown();
                CountDownLatch wait = hold;
                if (wait != null) {
                    try {
                        wait.await(10, TimeUnit.SECONDS);
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    }
                }
                byte[] answer = body.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, answer.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(answer);
                }
            });
            http.start();
        }

        String url() {
            return "http://127.0.0.1:" + http.getAddress().getPort() + "/api/proxy?endpoint=ep&uri=%2Fvoice%2Ftranscribe";
        }

        @Override
        public void close() {
            CountDownLatch wait = hold;
            if (wait != null) wait.countDown();
            http.stop(0);
        }
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        return out.toByteArray();
    }

    static Map<String, Object> uploadArgs(String id, String url, String field) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("id", id);
        args.put("url", url);
        args.put("method", "POST");
        Map<String, Object> headers = new LinkedHashMap<>();
        headers.put("Authorization", "Bearer token-1");
        args.put("headers", headers);
        if (field != null) {
            args.put("field", field);
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("language", "en");
            args.put("fields", fields);
        }
        return args;
    }

    /** Starts (granted) and stops a recording: its file's id. */
    static String recorded(VoiceController voice) throws Exception {
        Answer started = new Answer();
        voice.start(started);
        equal(started.await().map().get("ok"), true, "started");
        Answer stopped = new Answer();
        voice.stop(stopped);
        return String.valueOf(stopped.await().map().get("id"));
    }

    /* ---------- tests ---------- */

    static void permissionOutcomes() {
        VoicePermission.Outcome granted = VoicePermission.Outcome.GRANTED;
        VoicePermission.Outcome denied = VoicePermission.Outcome.DENIED;
        VoicePermission.Outcome blocked = VoicePermission.Outcome.BLOCKED;
        equal(VoicePermission.decide(true, false, false, false), granted, "granted");
        equal(VoicePermission.decide(true, true, false, true), granted, "granted after a refusal");
        // First refusal: the system asks again next time.
        equal(VoicePermission.decide(false, false, true, false), denied, "first refusal");
        // The first request dismissed (Android 11+ keeps no rationale): asked again next time.
        equal(VoicePermission.decide(false, false, false, false), denied, "first request dismissed");
        // Refused again after a rationale, or "Don't ask again": blocked.
        equal(VoicePermission.decide(false, true, false, true), blocked, "second refusal");
        equal(VoicePermission.decide(false, true, false, false), blocked, "don't ask again");
        // Asked before, and the system answered at once without a rationale: blocked earlier.
        equal(VoicePermission.decide(false, false, false, true), blocked, "blocked earlier");
        equal(VoicePermission.decide(false, true, true, true), denied, "refused again, still asking");
    }

    static void support(File dir) {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        equal(voice.support(), "", "with a microphone");
        platform.microphone = false;
        equal(voice.support(), "no_mic", "without one");
        Answer started = new Answer();
        voice.start(started);
        equal(started.map().get("error"), "no_mic", "start without a microphone");
        equal(platform.recordings.size(), 0, "no recorder");
    }

    static void recordAndUpload(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        Answer started = new Answer();
        voice.start(started);
        equal(started.map().get("ok"), true, "started");
        equal(platform.asked.size(), 0, "no question when allowed");
        FakeRecording recording = platform.last();
        check(recording.file.exists(), "recording into a file");
        Answer second = new Answer();
        voice.start(second);
        equal(second.map().get("error"), "busy", "one recording at a time");

        Answer stopped = new Answer();
        voice.stop(stopped);
        Map<String, Object> file = stopped.map();
        check(recording.stopped && recording.released, "microphone released");
        equal(file.get("name"), "voice.m4a", "name");
        equal(file.get("type"), "audio/mp4", "type");
        equal(file.get("size"), recording.file.length(), "size");

        try (Server server = new Server()) {
            Answer uploaded = new Answer();
            voice.upload(uploadArgs(String.valueOf(file.get("id")), server.url(), "audio"), uploaded);
            uploaded.await();
            check(uploaded.error == null, "upload failed: " + uploaded.error);
            Map<String, Object> result = uploaded.map();
            equal(result.get("ok"), true, "ok");
            equal(result.get("status"), 200, "status");
            equal(result.get("body"), "{\"text\":\"book a table\"}", "body");
            Map<String, String> headers = server.headers.get(0);
            equal(headers.get(":method"), "POST", "method");
            equal(headers.get("authorization"), "Bearer token-1", "auth header");
            check(headers.get("content-type").startsWith("multipart/form-data; boundary="), "multipart: " + headers.get("content-type"));
            String body = server.bodies.get(0);
            check(body.contains("Content-Disposition: form-data; name=\"language\"\r\n\r\nen\r\n"), "extra field: " + body);
            check(body.contains("Content-Disposition: form-data; name=\"audio\"; filename=\"voice.m4a\"\r\nContent-Type: audio/mp4\r\n\r\nfake aac audio\r\n--"), "file part: " + body);
            check(body.endsWith("--\r\n"), "closing boundary");
        }
        platform.join();
        check(!recording.file.exists(), "file deleted once sent");
        check(voice.idle(), "nothing held");
        equal(platform.events.size(), 0, "no events");
    }

    static void firstUseAsks(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        platform.permission = false;
        VoiceController voice = new VoiceController(platform);
        Answer started = new Answer();
        voice.start(started);
        equal(platform.asked.size(), 1, "asked");
        equal(started.answers, 0, "waits for the answer");
        equal(platform.recordings.size(), 0, "no recording before the answer");
        platform.permission = true;
        platform.asked.get(0).done(VoicePermission.Outcome.GRANTED);
        equal(started.map().get("ok"), true, "records once allowed");
        equal(platform.recordings.size(), 1, "recording");
        voice.cancel();
        check(platform.last().released && !platform.last().file.exists(), "cancel releases and deletes");
        check(voice.idle(), "nothing held");
    }

    static void deniedAndBlocked(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        platform.permission = false;
        VoiceController voice = new VoiceController(platform);
        Answer denied = new Answer();
        voice.start(denied);
        platform.asked.get(0).done(VoicePermission.Outcome.DENIED);
        equal(denied.map().get("ok"), false, "denied");
        equal(denied.map().get("error"), "permission-denied", "denied error");
        // Retry: asks again.
        Answer blocked = new Answer();
        voice.start(blocked);
        equal(platform.asked.size(), 2, "asked again on retry");
        platform.asked.get(1).done(VoicePermission.Outcome.BLOCKED);
        equal(blocked.map().get("error"), "permission-blocked", "blocked error");
        equal(platform.recordings.size(), 0, "never recorded");
        equal(platform.files(), 0, "no files");
        check(voice.idle(), "nothing held");
    }

    static void cancelWhileAsking(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        platform.permission = false;
        VoiceController voice = new VoiceController(platform);
        Answer started = new Answer();
        voice.start(started);
        voice.cancel();
        equal(started.map().get("error"), "cancelled", "answered cancelled");
        platform.permission = true;
        platform.asked.get(0).done(VoicePermission.Outcome.GRANTED);
        equal(started.answers, 1, "answered once");
        equal(platform.recordings.size(), 0, "the late grant records nothing");
        check(voice.idle(), "nothing held");
        equal(platform.events.size(), 0, "cancel by the app tells it nothing");
    }

    static void background(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        Answer started = new Answer();
        voice.start(started);
        FakeRecording recording = platform.last();
        voice.background();
        check(recording.stopped && recording.released, "microphone released");
        check(!recording.file.exists(), "file deleted");
        equal(platform.events, List.of("morph.voice.ended {reason=background}"), "the app is told");
        Answer stopped = new Answer();
        voice.stop(stopped);
        equal(stopped.value, null, "nothing to stop");
        // No recording while in the background.
        Answer away = new Answer();
        voice.start(away);
        equal(away.map().get("error"), "cancelled", "start in the background");
        equal(platform.recordings.size(), 1, "no new recording");
        // Leaving again with nothing under way says nothing.
        voice.background();
        equal(platform.events.size(), 1, "one event");
        voice.foreground();
        Answer back = new Answer();
        voice.start(back);
        equal(back.map().get("ok"), true, "records again in front");
        voice.cancel();
    }

    static void backgroundWhileAsking(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        platform.permission = false;
        VoiceController voice = new VoiceController(platform);
        Answer started = new Answer();
        voice.start(started);
        voice.background();
        equal(started.map().get("error"), "cancelled", "answered cancelled");
        platform.permission = true;
        platform.asked.get(0).done(VoicePermission.Outcome.GRANTED);
        equal(platform.recordings.size(), 0, "a grant after leaving records nothing");
        check(voice.idle(), "nothing held");
    }

    static void emptyRecording(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        platform.writeAudio = false;
        VoiceController voice = new VoiceController(platform);
        voice.start(new Answer());
        FakeRecording recording = platform.last();
        recording.audio = false;
        Answer stopped = new Answer();
        voice.stop(stopped);
        equal(stopped.value, null, "no file");
        check(recording.released, "released");
        check(!recording.file.exists(), "deleted");
        check(voice.idle(), "nothing held");
    }

    static void busyMicrophone(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        platform.busy = true;
        VoiceController voice = new VoiceController(platform);
        Answer started = new Answer();
        voice.start(started);
        equal(started.map().get("error"), "busy", "busy");
        equal(started.map().get("message"), "start failed", "message");
        equal(platform.files(), 0, "the empty file is gone");
        check(voice.idle(), "nothing held");
    }

    static void recorderError(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        voice.start(new Answer());
        FakeRecording first = platform.last();
        first.onError.failed("recorder died");
        check(first.released && !first.file.exists(), "released and deleted");
        equal(platform.events, List.of("morph.voice.ended {reason=error, message=recorder died}"), "the app is told");
        // An error of an older recording does not end the next one.
        voice.start(new Answer());
        FakeRecording second = platform.last();
        first.onError.failed("late");
        check(!second.released && second.file.exists(), "the new recording goes on");
        equal(platform.events.size(), 1, "no second event");
        voice.cancel();
    }

    static void cancelUpload(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        String id = recorded(voice);
        try (Server server = new Server()) {
            server.hold = new CountDownLatch(1);
            Answer uploaded = new Answer();
            voice.upload(uploadArgs(id, server.url(), "audio"), uploaded);
            check(server.received.await(10, TimeUnit.SECONDS), "request sent");
            voice.cancel();
            uploaded.await();
            equal(uploaded.error, "The recording was discarded.", "rejected");
            platform.join();
        }
        equal(platform.files(), 0, "file deleted");
        check(voice.idle(), "nothing held");
    }

    static void releaseAndClose(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        String id = recorded(voice);
        equal(platform.files(), 1, "kept until sent");
        voice.release(id);
        equal(platform.files(), 0, "released");
        Answer gone = new Answer();
        voice.upload(uploadArgs(id, "http://127.0.0.1:1/", "audio"), gone);
        equal(gone.error, "The recording is no longer available.", "a released file cannot be sent");

        recorded(voice);
        voice.start(new Answer());
        FakeRecording open = platform.last();
        voice.close();
        check(open.released, "microphone released");
        equal(platform.files(), 0, "everything deleted");
        Answer after = new Answer();
        voice.start(after);
        equal(after.map().get("error"), "cancelled", "nothing starts after close");
        check(voice.idle(), "nothing held");
    }

    static void rawUpload(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        String id = recorded(voice);
        try (Server server = new Server()) {
            Answer uploaded = new Answer();
            voice.upload(uploadArgs(id, server.url(), null), uploaded);
            uploaded.await();
            equal(server.bodies.get(0), "fake aac audio", "the file is the body");
            equal(server.headers.get(0).get("content-type"), "audio/mp4", "its type");
        }
        platform.join();
        equal(platform.files(), 0, "deleted");
    }

    static void httpError(File dir) throws Exception {
        FakePlatform platform = new FakePlatform(dir);
        VoiceController voice = new VoiceController(platform);
        String id = recorded(voice);
        AtomicReference<Answer> answer = new AtomicReference<>(new Answer());
        try (Server server = new Server()) {
            server.status = 502;
            server.body = "transcription failed: upstream";
            voice.upload(uploadArgs(id, server.url(), "audio"), answer.get());
            answer.get().await();
        }
        Map<String, Object> result = answer.get().map();
        equal(result.get("ok"), false, "not ok");
        equal(result.get("status"), 502, "status");
        equal(result.get("body"), "transcription failed: upstream", "body");
        platform.join();
        equal(platform.files(), 0, "deleted after a failed upload too");
    }
}
