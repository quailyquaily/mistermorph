package com.mistermorph.console;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * The task notifications' background watcher without Android: {@link TaskNotifier} on a fake
 * platform (saved values, clock, notifications, jobs) against a local HTTP server playing the
 * console's `/api/notifications/events` and topic reads. Plain Java, run by
 * scripts/android-host.sh test.
 */
public final class TaskNotifierTest {
    private static int passed;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        run("JSON answers are read", TaskNotifierTest::json);
        run("away: a chat completion is told once, with its topic's name and status", TaskNotifierTest::toldOnce);
        run("the leaving is where the watch starts; the cursor follows", TaskNotifierTest::cursor);
        run("in front: nothing is asked or told, and the job is cancelled", TaskNotifierTest::foreground);
        run("back in front while a name loads: nothing is told, and not later either", TaskNotifierTest::backWhileLoading);
        run("TODO runs and other events are never told", TaskNotifierTest::skipped);
        run("notifications off, or signed out: no watch", TaskNotifierTest::notAllowed);
        run("an ended session stops the watch and forgets the token", TaskNotifierTest::sessionEnded);
        run("an older server without the events stops the watch", TaskNotifierTest::olderServer);
        run("an unreachable server is tried again after growing pauses", TaskNotifierTest::retries);
        run("a name that cannot be read gives the untitled label", TaskNotifierTest::untitled);
        run("told completions are remembered across process restarts", TaskNotifierTest::restart);
        run("the job asks while tasks run, rests while none do, and ends after a day", TaskNotifierTest::work);
        run("another server or session starts over", TaskNotifierTest::reconfigure);
        run("a pressed notification's topic is taken once", TaskNotifierTest::opened);
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

    static final class Posted {
        final String tag;
        final String title;
        final String body;
        final String topicID;

        Posted(String tag, String title, String body, String topicID) {
            this.tag = tag;
            this.title = title;
            this.body = body;
            this.topicID = topicID;
        }
    }

    static final class FakePlatform implements TaskNotifier.Platform {
        final Map<String, String> saved;
        volatile long now = 1_000_000;
        volatile boolean allowed = true;
        final List<Posted> posted = Collections.synchronizedList(new ArrayList<>());
        final List<Long> scheduled = Collections.synchronizedList(new ArrayList<>());

        FakePlatform() {
            this(new ConcurrentHashMap<>());
        }

        FakePlatform(Map<String, String> saved) {
            this.saved = saved;
        }

        @Override
        public String get(String key) {
            return saved.get(key);
        }

        @Override
        public void put(String key, String value) {
            if (value == null) saved.remove(key);
            else saved.put(key, value);
        }

        @Override
        public long elapsed() {
            return now;
        }

        @Override
        public boolean canNotify() {
            return allowed;
        }

        @Override
        public void post(String tag, String title, String body, String topicID) {
            posted.add(new Posted(tag, title, body, topicID));
        }

        @Override
        public void schedule(long delayMs) {
            scheduled.add(delayMs);
        }

        long lastScheduled() {
            return scheduled.isEmpty() ? Long.MIN_VALUE : scheduled.get(scheduled.size() - 1);
        }
    }

    /** The console server: answers its events from a queue (the last one repeats) and topic reads by ID. */
    static final class FakeServer implements AutoCloseable {
        final HttpServer server;
        final ConcurrentLinkedQueue<Object[]> answers = new ConcurrentLinkedQueue<>();
        volatile Object[] last = {200, page(0, 0)};
        final List<Map<String, String>> requests = Collections.synchronizedList(new ArrayList<>());
        final Map<String, String> titles = new ConcurrentHashMap<>();
        volatile Runnable onTitle = () -> {};

        FakeServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/api/notifications/events", (exchange) -> {
                Map<String, String> query = query(exchange);
                query.put("authorization", String.valueOf(exchange.getRequestHeaders().getFirst("Authorization")));
                requests.add(query);
                Object[] answer = answers.poll();
                if (answer == null) answer = last;
                else last = answer;
                respond(exchange, (Integer) answer[0], (String) answer[1]);
            });
            server.createContext("/api/proxy", (exchange) -> {
                Map<String, String> query = query(exchange);
                onTitle.run();
                String uri = query.getOrDefault("uri", "");
                String id = uri.startsWith("/topics/") ? URLDecoder.decode(uri.substring(8), "UTF-8") : "";
                String title = "ep_console_local".equals(query.get("endpoint")) ? titles.get(id) : null;
                if (title == null) respond(exchange, 404, "{\"error\":\"not found\"}");
                else respond(exchange, 200, "{\"id\":\"" + id + "\",\"title\":\"" + title + "\"}");
            });
            server.start();
        }

        String api() {
            return "http://127.0.0.1:" + server.getAddress().getPort() + "/api/";
        }

        void answer(int status, String body) {
            answers.add(new Object[] {status, body});
        }

        Map<String, String> lastRequest() {
            return requests.get(requests.size() - 1);
        }

        private static Map<String, String> query(HttpExchange exchange) throws IOException {
            Map<String, String> out = new HashMap<>();
            String raw = exchange.getRequestURI().getRawQuery();
            if (raw == null) return out;
            for (String pair : raw.split("&")) {
                int eq = pair.indexOf('=');
                if (eq < 0) continue;
                out.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"), URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            }
            return out;
        }

        private static void respond(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }

    static String event(String task, String topic, String status) {
        return "{\"id\":\"topic-task:" + task + "\",\"type\":\"topic_task_completed\",\"topic_id\":\"" + topic + "\",\"status\":\"" + status + "\"}";
    }

    static String page(long cursor, int active, String... events) {
        return "{\"epoch\":\"e1\",\"cursor\":" + cursor + ",\"active\":" + active + ",\"events\":[" + String.join(",", events) + "]}";
    }

    static Map<String, Object> settings(String api, String token) {
        Map<String, Object> texts = new LinkedHashMap<>();
        texts.put("untitled", "Untitled topic");
        texts.put("done", "Task finished");
        texts.put("failed", "Task failed");
        texts.put("channel", "Topic task notifications");
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("api", api);
        args.put("token", token);
        args.put("texts", texts);
        return args;
    }

    /** A notifier signed in to {@code server} that just left the foreground. */
    static TaskNotifier away(FakePlatform platform, FakeServer server) {
        TaskNotifier notifier = new TaskNotifier(platform);
        notifier.configure(settings(server.api(), "token-1"));
        notifier.foreground();
        notifier.background();
        return notifier;
    }

    /* ---------- tests ---------- */

    static void json() {
        Map<?, ?> value = Json.object(Json.parse(" {\"a\": [1, -2.5e1, true, false, null], \"s\": \"q\\\"\\u00e9\\n\", \"o\": {}} "));
        equal(Json.array(value.get("a")).size(), 5, "array");
        equal(Json.number(Json.array(value.get("a")).get(1), 0), -25L, "number");
        equal(value.get("s"), "q\"é\n", "string");
        check(Json.object(value.get("o")).isEmpty(), "object");
        for (String bad : new String[] {"", "{", "[1,]", "{\"a\" 1}", "nul", "\"open", "{} x"}) {
            try {
                Json.parse(bad);
                throw new AssertionError("parsed " + bad);
            } catch (IllegalArgumentException expected) {
                // refused
            }
        }
    }

    static void toldOnce() throws Exception {
        try (FakeServer server = new FakeServer()) {
            server.titles.put("topic 1", "Ops review");
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            equal(platform.lastScheduled(), 0L, "leaving schedules the job at once");
            platform.now += 4_000;
            server.answer(200, page(7, 0, event("t1", "topic 1", "done"), event("t2", "topic 1", "failed")));
            equal(notifier.poll(0), TaskNotifier.Next.AGAIN, "a completion came: ask again");
            Map<String, String> first = server.lastRequest();
            equal(first.get("since_ms"), "4000", "first request reads since the leaving");
            check(!first.containsKey("after"), "no cursor before the first answer");
            equal(first.get("authorization"), "Bearer token-1", "the session's token");
            equal(platform.posted.size(), 2, "both completions told");
            Posted done = platform.posted.get(0);
            equal(done.tag, "topic-task:t1", "tag");
            equal(done.title, "Ops review", "the topic's name is the title");
            equal(done.body, "Task finished", "status text");
            equal(done.topicID, "topic 1", "press target");
            equal(platform.posted.get(1).body, "Task failed", "failed text");

            // The server repeats them (a restart, or the same page): never told twice.
            server.answer(200, page(7, 0, event("t1", "topic 1", "done")));
            notifier.poll(0);
            equal(platform.posted.size(), 2, "no repeat");
        }
    }

    static void cursor() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.answer(200, page(3, 1));
            notifier.poll(0);
            notifier.poll(0);
            equal(server.lastRequest().get("after"), "3", "the cursor of the last answer");
            equal(server.lastRequest().get("epoch"), "e1", "of that server start");
            // Back in front and away again: the completions in between were the app's to show.
            notifier.foreground();
            platform.now += 60_000;
            notifier.background();
            platform.now += 1_000;
            notifier.poll(0);
            check(!server.lastRequest().containsKey("after"), "a new leaving starts without a cursor");
            equal(server.lastRequest().get("since_ms"), "1000", "and reads since that leaving");
        }
    }

    static void foreground() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            notifier.foreground();
            equal(platform.lastScheduled(), TaskNotifier.STOP, "coming back cancels the job");
            server.answer(200, page(1, 0, event("t1", "topic-1", "done")));
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "a job that still runs stops");
            equal(server.requests.size(), 0, "nothing asked in front");
            equal(platform.posted.size(), 0, "nothing told in front");
        }
    }

    static void backWhileLoading() throws Exception {
        try (FakeServer server = new FakeServer()) {
            server.titles.put("topic-1", "Ops");
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.onTitle = notifier::foreground;
            server.answer(200, page(1, 0, event("t1", "topic-1", "done")));
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "in front after the answer");
            equal(platform.posted.size(), 0, "not told once the app is back");
            // Away again and the same completion comes once more: it was consumed, as on the web.
            server.onTitle = () -> {};
            notifier.background();
            server.answer(200, page(1, 0, event("t1", "topic-1", "done")));
            notifier.poll(0);
            equal(platform.posted.size(), 0, "a consumed completion stays untold");
        }
    }

    static void skipped() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            String cron = "{\"id\":\"topic-task:c\",\"type\":\"topic_task_completed\",\"topic_id\":\"t\",\"status\":\"done\",\"trigger\":\"cron\"}";
            String other = "{\"id\":\"run-1\",\"title\":\"Daily\",\"body\":\"Done\"}";
            server.answer(200, page(4, 0, cron, other, event("r", "topic-1", "running"), event("n", "", "done")));
            notifier.poll(0);
            equal(platform.posted.size(), 0, "none of them told");
        }
    }

    static void notAllowed() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            platform.allowed = false;
            TaskNotifier notifier = away(platform, server);
            equal(platform.lastScheduled(), TaskNotifier.STOP, "no job without permission");
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "a job left over stops");
            equal(server.requests.size(), 0, "nothing asked");

            // Allowed, then turned off while away: the watch ends at its next request.
            platform.allowed = true;
            notifier.background();
            equal(platform.lastScheduled(), 0L, "allowed: watched");
            platform.allowed = false;
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "turned off while away");

            // Signed out: the app configures no token.
            platform.allowed = true;
            notifier.background();
            notifier.configure(settings(server.api(), ""));
            equal(platform.lastScheduled(), TaskNotifier.STOP, "signing out cancels the job");
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "signed out");
            notifier.background();
            equal(platform.lastScheduled(), TaskNotifier.STOP, "leaving signed out watches nothing");
            equal(server.requests.size(), 0, "nothing asked signed out");
        }
    }

    static void sessionEnded() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.answer(401, "{\"error\":\"unauthorized\"}");
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "an ended session stops");
            equal(platform.get(TaskNotifier.TOKEN), null, "the token is forgotten");
            notifier.background();
            equal(platform.lastScheduled(), TaskNotifier.STOP, "no watch until the app signs in again");
        }
    }

    static void olderServer() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.answer(404, "404 page not found");
            equal(notifier.poll(0), TaskNotifier.Next.STOP, "no events route");
        }
    }

    static void retries() throws Exception {
        FakePlatform platform = new FakePlatform();
        TaskNotifier notifier = new TaskNotifier(platform);
        // A port nothing listens on.
        int port;
        try (java.net.ServerSocket closed = new java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            port = closed.getLocalPort();
        }
        notifier.configure(settings("http://127.0.0.1:" + port + "/api", "token-1"));
        notifier.background();
        equal(notifier.poll(0), TaskNotifier.Next.RETRY, "unreachable");
        equal(notifier.work(60_000, () -> true), TaskNotifier.RETRY_FIRST_MS, "first pause");
        equal(notifier.work(60_000, () -> true), 2 * TaskNotifier.RETRY_FIRST_MS, "then longer");
        for (int i = 0; i < 12; i++) notifier.work(60_000, () -> true);
        equal(notifier.work(60_000, () -> true), TaskNotifier.RETRY_MAX_MS, "at most the idle pause");
        try (FakeServer server = new FakeServer()) {
            notifier.configure(settings(server.api(), "token-1"));
            notifier.background();
            server.answer(500, "{}");
            equal(notifier.poll(0), TaskNotifier.Next.RETRY, "a server error");
            server.answer(200, "not json");
            equal(notifier.poll(0), TaskNotifier.Next.RETRY, "a garbled answer");
        }
    }

    static void untitled() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.answer(200, page(1, 0, event("t1", "deleted-topic", "done")));
            notifier.poll(0);
            equal(platform.posted.size(), 1, "told");
            equal(platform.posted.get(0).title, "Untitled topic", "the untitled label, never the ID");
            equal(platform.posted.get(0).topicID, "deleted-topic", "the press still names it; the app checks it");
        }
    }

    static void restart() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.answer(200, page(1, 0, event("t1", "topic-1", "done")));
            notifier.poll(0);
            equal(platform.posted.size(), 1, "told");
            // Android ended the process; the job starts it again with the same saved values.
            FakePlatform again = new FakePlatform(platform.saved);
            again.now = platform.now + 1_000;
            TaskNotifier restarted = new TaskNotifier(again);
            check(!restarted.isForeground(), "a process the job started is away");
            // The server restarted too: a new epoch, and the completion comes again by its time.
            server.answer(200, page(1, 0, event("t1", "topic-1", "done")).replace("e1", "e2"));
            equal(restarted.poll(0), TaskNotifier.Next.AGAIN, "asked");
            equal(again.posted.size(), 0, "not told twice on this device");
            equal(server.lastRequest().get("after"), "1", "the saved cursor is sent");

            // Remembered IDs are bounded.
            for (int i = 0; i < TaskNotifier.DELIVERED_LIMIT + 10; i++) check(restarted.claim("x" + i), "new id");
            check(!restarted.claim("x" + (TaskNotifier.DELIVERED_LIMIT + 9)), "recent ids remembered");
            check(restarted.claim("x0"), "the oldest are forgotten");
        }
    }

    static void work() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            // Something runs: it keeps asking until the budget is spent, then hands over at once.
            server.last = new Object[] {200, page(0, 1)};
            long[] calls = {0};
            long next = notifier.work(TaskNotifier.WAIT_SECONDS * 1000L * 3, () -> {
                platform.now += TaskNotifier.WAIT_SECONDS * 1000L;
                return ++calls[0] < 10;
            });
            equal(next, 0L, "the next job at once");
            check(server.requests.size() >= 2, "asked more than once: " + server.requests.size());

            // Nothing runs: rest.
            server.last = new Object[] {200, page(0, 0)};
            equal(notifier.work(TaskNotifier.JOB_BUDGET_MS, () -> true), TaskNotifier.IDLE_DELAY_MS, "idle pause");

            // Stopped by the scheduler: it reschedules itself.
            equal(notifier.work(TaskNotifier.JOB_BUDGET_MS, () -> false), TaskNotifier.STOP, "stopped");

            // A day away: the watch ends.
            platform.now += TaskNotifier.WATCH_LIMIT_MS + 1;
            int asked = server.requests.size();
            equal(notifier.work(TaskNotifier.JOB_BUDGET_MS, () -> true), TaskNotifier.STOP, "away too long");
            equal(server.requests.size(), asked, "nothing asked after a day");
        }
    }

    static void reconfigure() throws Exception {
        try (FakeServer server = new FakeServer()) {
            FakePlatform platform = new FakePlatform();
            TaskNotifier notifier = away(platform, server);
            server.answer(200, page(5, 0));
            notifier.poll(0);
            equal(platform.get(TaskNotifier.CURSOR), "5", "cursor kept");
            notifier.configure(settings(server.api(), "token-2"));
            equal(platform.get(TaskNotifier.CURSOR), null, "a new session forgets the cursor");
            notifier.poll(0);
            equal(server.lastRequest().get("authorization"), "Bearer token-2", "the new token");
            notifier.configure(settings("ftp://elsewhere", "token-2"));
            equal(platform.lastScheduled(), TaskNotifier.STOP, "no usable address: no watch");
        }
    }

    static void opened() {
        FakePlatform platform = new FakePlatform();
        TaskNotifier notifier = new TaskNotifier(platform);
        check(!notifier.hasOpened(), "nothing pressed");
        notifier.opened("topic-9");
        check(notifier.hasOpened(), "pressed");
        // The process may end before the app takes it.
        TaskNotifier restarted = new TaskNotifier(new FakePlatform(platform.saved));
        equal(restarted.takeOpened(), "topic-9", "taken");
        equal(restarted.takeOpened(), "", "once");
        notifier.opened(" ");
        equal(notifier.takeOpened(), "", "a blank topic is none");
    }
}
