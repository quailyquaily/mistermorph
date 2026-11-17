package com.mistermorph.console;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The phone app's file saving without Android: {@link FileSaver} on a fake platform (a picker the
 * test answers, documents in memory) and {@link FileDownload} against local HTTP servers. Plain Java
 * (no test framework): scripts/android-host.sh test compiles and runs it on the JDK.
 */
public final class FileSaverTest {
    private static int passed;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        run("support says whether there is a picker for new documents", FileSaverTest::support);
        run("names: kept, cleaned of separators, or the default", FileSaverTest::names);
        run("the picker's type follows the name's extension, else plain bytes", FileSaverTest::types);
        run("a bad request fails before any picker", FileSaverTest::badRequests);
        run("a download is written byte for byte with the session's header, then saved", FileSaverTest::download);
        run("an empty file is saved empty", FileSaverTest::emptyFile);
        run("text and base64 are written as they are", FileSaverTest::textAndBase64);
        run("backing out of the picker is cancelled: nothing downloaded, nothing written", FileSaverTest::cancelled);
        run("a picker that cannot open fails", FileSaverTest::pickerFails);
        run("an HTTP error says the server's error and deletes the document", FileSaverTest::httpError);
        run("a redirect is not followed and the header goes nowhere else", FileSaverTest::redirect);
        run("a body cut short fails and deletes the document", FileSaverTest::cutShort);
        run("an unreachable server fails and deletes the document", FileSaverTest::unreachable);
        run("a document that cannot be opened, written or closed fails and is deleted", FileSaverTest::writeFailures);
        run("one picker at a time; after an answer the next save goes ahead", FileSaverTest::onePicker);
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
        } catch (Throwable e) {
            failures.add(name + ": " + e);
        }
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    private static void equal(Object want, Object got, String what) {
        if (want == null ? got != null : !want.equals(got)) throw new AssertionError(what + ": want " + want + ", got " + got);
    }

    /** A document the fake picker made: its bytes, whether it was closed, deleted. */
    static final class Document {
        final String name;
        final String mime;
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean opened;
        boolean closed;
        boolean deleted;
        String failOn = "";

        Document(String name, String mime) {
            this.name = name;
            this.mime = mime;
        }
    }

    static final class FakePlatform implements FileSaver.Platform {
        boolean picker = true;
        final List<Document> documents = new ArrayList<>();
        FileSaver.DestinationCallback waiting;
        String lastName;
        String lastMime;
        int picks;

        @Override
        public boolean canPickDestination() {
            return picker;
        }

        @Override
        public void pickDestination(String name, String mime, FileSaver.DestinationCallback callback) {
            picks++;
            lastName = name;
            lastMime = mime;
            waiting = callback;
        }

        /** The user chose a place: a new document there. */
        Document choose(String failOn) {
            Document document = new Document(lastName, lastMime);
            document.failOn = failOn;
            documents.add(document);
            FileSaver.DestinationCallback callback = waiting;
            waiting = null;
            callback.picked(document);
            return document;
        }

        @Override
        public OutputStream open(Object destination) throws IOException {
            Document document = (Document) destination;
            if (document.failOn.equals("open")) throw new IOException("no such document");
            document.opened = true;
            return new OutputStream() {
                @Override
                public void write(int b) throws IOException {
                    write(new byte[] {(byte) b}, 0, 1);
                }

                @Override
                public void write(byte[] b, int off, int len) throws IOException {
                    if (document.failOn.equals("write")) throw new IOException("no space left");
                    document.bytes.write(b, off, len);
                }

                @Override
                public void close() throws IOException {
                    if (document.failOn.equals("close")) throw new IOException("upload to the cloud failed");
                    document.closed = true;
                }
            };
        }

        @Override
        public void discard(Object destination) {
            ((Document) destination).deleted = true;
        }

        @Override
        public String mimeForExtension(String extension) {
            switch (extension) {
                case "txt":
                    return "text/plain";
                case "pdf":
                    return "application/pdf";
                case "png":
                    return "image/png";
                default:
                    return null;
            }
        }

        @Override
        public void runInBackground(Runnable task) {
            task.run();
        }
    }

    /** What a save answered; with the document's state when it answered. */
    static final class Answer implements FileSaver.Reply {
        Object value;
        String error;
        int answers;
        // The platform whose newest document is snapshotted when the save answers.
        FakePlatform platform;
        byte[] bytesAtAnswer;
        boolean closedAtAnswer;

        Answer watching(FakePlatform platform) {
            this.platform = platform;
            return this;
        }

        @Override
        public void resolve(Object value) {
            answers++;
            this.value = value;
            snapshot();
        }

        @Override
        public void reject(String message) {
            answers++;
            error = message;
            snapshot();
        }

        private void snapshot() {
            if (platform == null || platform.documents.isEmpty()) return;
            Document document = platform.documents.get(platform.documents.size() - 1);
            bytesAtAnswer = document.bytes.toByteArray();
            closedAtAnswer = document.closed;
        }
    }

    private static Map<String, Object> args(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }

    private static Map<String, Object> bearer(String token) {
        Map<String, Object> headers = new LinkedHashMap<>();
        headers.put("Authorization", "Bearer " + token);
        return headers;
    }

    /** A server answering every path with {@code status} and {@code body}, recording the Authorization headers. */
    private static HttpServer serve(int status, byte[] body, Map<String, String> extraHeaders, List<String> auth) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            auth.add(String.valueOf(exchange.getRequestHeaders().getFirst("Authorization")));
            for (Map.Entry<String, String> entry : extraHeaders.entrySet()) exchange.getResponseHeaders().add(entry.getKey(), entry.getValue());
            exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return server;
    }

    private static String address(HttpServer server, String path) {
        return "http://127.0.0.1:" + server.getAddress().getPort() + path;
    }

    private static void support() {
        FakePlatform platform = new FakePlatform();
        equal("", new FileSaver(platform).support(), "with a picker");
        platform.picker = false;
        equal("unsupported", new FileSaver(platform).support(), "without one");
    }

    private static void names() {
        equal("report.pdf", FileSaver.safeName("report.pdf"), "a plain name");
        equal("notes 2026.md", FileSaver.safeName("  notes 2026.md "), "trimmed");
        equal("a_b_c.txt", FileSaver.safeName("a/b\\c.txt"), "separators");
        equal("x_y", FileSaver.safeName("x\ny"), "control characters");
        equal("报告.txt", FileSaver.safeName("报告.txt"), "non-ASCII kept");
        equal(FileSaver.DEFAULT_NAME, FileSaver.safeName(""), "empty");
        equal(FileSaver.DEFAULT_NAME, FileSaver.safeName(null), "null");
        equal(FileSaver.DEFAULT_NAME, FileSaver.safeName(".."), "dot-dot");
    }

    private static void types() {
        FileSaver saver = new FileSaver(new FakePlatform());
        equal("text/plain", saver.mimeFor("notes.TXT"), "known extension, any case");
        equal("application/pdf", saver.mimeFor("report.pdf"), "pdf");
        equal(FileSaver.BINARY, saver.mimeFor("data.weird"), "unknown extension");
        equal(FileSaver.BINARY, saver.mimeFor("README"), "no extension");
        equal(FileSaver.BINARY, saver.mimeFor(".env"), "a dot file");
        equal(FileSaver.BINARY, saver.mimeFor("trailing."), "a trailing dot");
    }

    private static void badRequests() {
        FakePlatform platform = new FakePlatform();
        FileSaver saver = new FileSaver(platform);
        Object[][] cases = {
            {args("name", "x"), "Nothing to save."},
            {args("name", "x", "url", "file:///etc/passwd"), "The file's address is not an http(s) URL."},
            {args("name", "x", "url", "not a url"), "The file's address is not an http(s) URL."},
            {args("name", "x", "base64", "%%%"), "The file's contents are not valid base64."},
        };
        for (Object[] item : cases) {
            Answer answer = new Answer();
            @SuppressWarnings("unchecked")
            Map<String, Object> request = (Map<String, Object>) item[0];
            saver.save(request, answer);
            equal(item[1], answer.error, "error for " + request);
        }
        equal(0, platform.picks, "no picker shown");
    }

    private static void download() throws Exception {
        byte[] body = new byte[200_000];
        for (int i = 0; i < body.length; i++) body[i] = (byte) (i * 31 + 7);
        List<String> auth = new ArrayList<>();
        HttpServer server = serve(200, body, new LinkedHashMap<>(), auth);
        try {
            FakePlatform platform = new FakePlatform();
            FileSaver saver = new FileSaver(platform);
            Answer answer = new Answer().watching(platform);
            saver.save(args("name", "report.pdf", "url", address(server, "/api/attachments?id=a1"), "headers", bearer("token-1")), answer);
            equal("report.pdf", platform.lastName, "the picker's name");
            equal("application/pdf", platform.lastMime, "the picker's type");
            equal(0, answer.answers, "nothing answered while the picker is open");
            equal(0, auth.size(), "nothing downloaded before a place is chosen");
            Document document = platform.choose("");
            equal("saved", answer.value, "answer");
            equal(1, answer.answers, "answered once");
            // "saved" came once every byte was written and the document closed.
            check(Arrays.equals(body, answer.bytesAtAnswer), "all bytes written when it answered");
            check(answer.closedAtAnswer, "closed when it answered");
            check(Arrays.equals(body, document.bytes.toByteArray()), "the bytes are the server's");
            check(document.closed, "the document is closed");
            check(!document.deleted, "the document stays");
            equal(Arrays.asList("Bearer token-1"), auth, "the session's header went to the console");
        } finally {
            server.stop(0);
        }
    }

    private static void emptyFile() throws Exception {
        List<String> auth = new ArrayList<>();
        HttpServer server = serve(200, new byte[0], new LinkedHashMap<>(), auth);
        try {
            FakePlatform platform = new FakePlatform();
            Answer answer = new Answer();
            new FileSaver(platform).save(args("name", "empty.txt", "url", address(server, "/f")), answer);
            Document document = platform.choose("");
            equal("saved", answer.value, "answer");
            equal(0, document.bytes.size(), "empty");
            check(document.closed && !document.deleted, "kept");
        } finally {
            server.stop(0);
        }
    }

    private static void textAndBase64() {
        FakePlatform platform = new FakePlatform();
        FileSaver saver = new FileSaver(platform);
        Answer text = new Answer();
        saver.save(args("name", "run.log", "text", "line 1\nzwei — 2\n", "type", "text/plain"), text);
        Document log = platform.choose("");
        equal("saved", text.value, "text answer");
        equal("line 1\nzwei — 2\n", new String(log.bytes.toByteArray(), StandardCharsets.UTF_8), "text bytes");
        byte[] raw = {0, (byte) 0xff, 0x10, (byte) 0x80};
        Answer bytes = new Answer();
        saver.save(args("name", "blob.bin", "base64", Base64.getEncoder().encodeToString(raw)), bytes);
        Document blob = platform.choose("");
        equal("saved", bytes.value, "base64 answer");
        check(Arrays.equals(raw, blob.bytes.toByteArray()), "base64 bytes");
    }

    private static void cancelled() throws Exception {
        List<String> auth = new ArrayList<>();
        HttpServer server = serve(200, "x".getBytes(StandardCharsets.UTF_8), new LinkedHashMap<>(), auth);
        try {
            FakePlatform platform = new FakePlatform();
            Answer answer = new Answer();
            new FileSaver(platform).save(args("name", "a.txt", "url", address(server, "/f"), "headers", bearer("t")), answer);
            FileSaver.DestinationCallback callback = platform.waiting;
            callback.cancelled();
            equal("cancelled", answer.value, "answer");
            equal(null, answer.error, "no error");
            equal(0, auth.size(), "nothing downloaded");
            equal(0, platform.documents.size(), "nothing written");
            // A late answer from the same picker changes nothing.
            callback.picked(new Document("a.txt", "text/plain"));
            equal(1, answer.answers, "answered once");
        } finally {
            server.stop(0);
        }
    }

    private static void pickerFails() {
        FakePlatform platform = new FakePlatform();
        Answer answer = new Answer();
        new FileSaver(platform).save(args("name", "a.txt", "text", "x"), answer);
        platform.waiting.failed("No app on this device can save files.");
        equal("No app on this device can save files.", answer.error, "error");
        equal(null, answer.value, "no value");
    }

    private static void httpError() throws Exception {
        List<String> auth = new ArrayList<>();
        HttpServer server = serve(404, "{\"error\":\"attachment not found\"}".getBytes(StandardCharsets.UTF_8), new LinkedHashMap<>(), auth);
        HttpServer plain = serve(500, new byte[0], new LinkedHashMap<>(), auth);
        try {
            FakePlatform platform = new FakePlatform();
            FileSaver saver = new FileSaver(platform);
            Answer answer = new Answer();
            saver.save(args("name", "a.pdf", "url", address(server, "/f")), answer);
            Document document = platform.choose("");
            equal("attachment not found", answer.error, "the server's error");
            check(document.deleted, "the document is deleted");
            Answer bare = new Answer();
            saver.save(args("name", "a.pdf", "url", address(plain, "/f")), bare);
            Document second = platform.choose("");
            equal("HTTP 500", bare.error, "the status without a body");
            check(second.deleted, "deleted too");
        } finally {
            server.stop(0);
            plain.stop(0);
        }
    }

    private static void redirect() throws Exception {
        List<String> elsewhere = new ArrayList<>();
        HttpServer other = serve(200, "secret".getBytes(StandardCharsets.UTF_8), new LinkedHashMap<>(), elsewhere);
        Map<String, String> location = new LinkedHashMap<>();
        location.put("Location", address(other, "/stolen"));
        List<String> auth = new ArrayList<>();
        HttpServer server = serve(302, new byte[0], location, auth);
        try {
            FakePlatform platform = new FakePlatform();
            Answer answer = new Answer();
            new FileSaver(platform).save(args("name", "a.pdf", "url", address(server, "/f"), "headers", bearer("token-1")), answer);
            Document document = platform.choose("");
            check(answer.error != null && answer.error.contains("redirected"), "fails: " + answer.error);
            equal(0, elsewhere.size(), "the other server got nothing");
            equal(0, document.bytes.size(), "nothing written");
            check(document.deleted, "deleted");
        } finally {
            server.stop(0);
            other.stop(0);
        }
    }

    private static void cutShort() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, 1000);
            OutputStream out = exchange.getResponseBody();
            out.write(new byte[10]);
            out.flush();
            // Gone after 10 of 1000 bytes.
            exchange.close();
        });
        server.start();
        try {
            FakePlatform platform = new FakePlatform();
            Answer answer = new Answer();
            new FileSaver(platform).save(args("name", "a.bin", "url", address(server, "/f")), answer);
            Document document = platform.choose("");
            check(answer.error != null, "fails");
            equal(null, answer.value, "not saved");
            check(document.deleted, "deleted");
        } finally {
            server.stop(0);
        }
    }

    private static void unreachable() throws Exception {
        int port;
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        FakePlatform platform = new FakePlatform();
        Answer answer = new Answer();
        new FileSaver(platform).save(args("name", "a.bin", "url", "http://127.0.0.1:" + port + "/f"), answer);
        Document document = platform.choose("");
        check(answer.error != null && answer.error.startsWith("The download failed: "), "fails: " + answer.error);
        check(document.deleted, "deleted");
    }

    private static void writeFailures() throws Exception {
        List<String> auth = new ArrayList<>();
        HttpServer server = serve(200, "contents".getBytes(StandardCharsets.UTF_8), new LinkedHashMap<>(), auth);
        try {
            String[][] cases = {
                {"open", "The file could not be written: no such document"},
                {"write", "The file could not be written: no space left"},
                {"close", "The file could not be written: upload to the cloud failed"},
            };
            for (String[] item : cases) {
                FakePlatform platform = new FakePlatform();
                Answer answer = new Answer();
                new FileSaver(platform).save(args("name", "a.txt", "url", address(server, "/f")), answer);
                Document document = platform.choose(item[0]);
                equal(item[1], answer.error, item[0]);
                equal(null, answer.value, item[0] + ": not saved");
                check(document.deleted, item[0] + ": deleted");
            }
            FakePlatform platform = new FakePlatform();
            Answer answer = new Answer();
            new FileSaver(platform).save(args("name", "a.txt", "text", "x"), answer);
            Document document = platform.choose("write");
            equal("The file could not be written: no space left", answer.error, "text write");
            check(document.deleted, "text: deleted");
        } finally {
            server.stop(0);
        }
    }

    private static void onePicker() {
        FakePlatform platform = new FakePlatform();
        FileSaver saver = new FileSaver(platform);
        Answer first = new Answer();
        saver.save(args("name", "a.txt", "text", "a"), first);
        Answer second = new Answer();
        saver.save(args("name", "b.txt", "text", "b"), second);
        equal("Another file is waiting for a place to be saved.", second.error, "the second waits for nothing");
        equal(1, platform.picks, "one picker");
        platform.choose("");
        equal("saved", first.value, "the first saves");
        Answer third = new Answer();
        saver.save(args("name", "c.txt", "text", "c"), third);
        Document document = platform.choose("");
        equal("saved", third.value, "the next one goes ahead");
        equal("c", new String(document.bytes.toByteArray(), StandardCharsets.UTF_8), "its bytes");
    }
}
