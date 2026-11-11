package com.mistermorph.console;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Tells the user that a task in one of their topics finished while the phone app was not in the
 * foreground, as the web console's notification does in a background tab (lib/core/topic-task-
 * notifications.js): the topic's name and whether the task finished or failed, nothing of its text.
 *
 * <p>The app's page is suspended in the background, so its notification socket cannot do it. While
 * the app is away this watcher reads the console server's recent completions over HTTP
 * (`GET /api/notifications/events`, waiting there for the next one) from a JobScheduler job
 * ({@link TaskNotifierJob}), which runs without the app's page and after Android ended the app's
 * process. It asks often while the server has chat tasks queued or running and every
 * {@link #IDLE_DELAY_MS} otherwise, for at most {@link #WATCH_LIMIT_MS} after the app left.
 *
 * <p>The app configures it ({@code morph.notify.configure}: the server's API address, the session's
 * token and the texts in the app's language) and says when it comes and goes ({@link #foreground},
 * {@link #background}); everything it keeps outlives the process. Android's part (saved values,
 * the clock, notifications, jobs) is a {@link Platform}: a fake one in the JVM tests.
 */
final class TaskNotifier {
    /** How long one request waits on the server for a completion. */
    static final int WAIT_SECONDS = 50;
    /** How long one job asks before it hands over to the next (Android stops a job after 10 min). */
    static final long JOB_BUDGET_MS = 8 * 60_000L;
    /** The pause between checks while nothing runs on the server. */
    static final long IDLE_DELAY_MS = 15 * 60_000L;
    /** How long after leaving the app the watcher keeps going. */
    static final long WATCH_LIMIT_MS = 24 * 60 * 60_000L;
    static final long RETRY_FIRST_MS = 30_000L;
    static final long RETRY_MAX_MS = IDLE_DELAY_MS;
    /** How long a notification waits for its topic's name before it goes out without one. */
    static final int TITLE_TIMEOUT_MS = 3_000;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    /** How many delivered completions are remembered, so none is told twice. */
    static final int DELIVERED_LIMIT = 128;

    /** What the scheduler should do after a job: run again at once, after a delay, or not at all. */
    static final long STOP = -1;

    static final String API = "api";
    static final String TOKEN = "token";
    static final String TEXT_UNTITLED = "text_untitled";
    static final String TEXT_DONE = "text_done";
    static final String TEXT_FAILED = "text_failed";
    static final String TEXT_CHANNEL = "text_channel";
    static final String AWAY_SINCE = "away_since";
    static final String EPOCH = "epoch";
    static final String CURSOR = "cursor";
    static final String RETRIES = "retries";
    static final String DELIVERED = "delivered";
    static final String OPENED = "opened";

    /** What the watcher needs from Android. */
    interface Platform {
        /** A saved value, or null. Saved values outlive the process. */
        String get(String key);

        /** Saves {@code value}; null removes it. */
        void put(String key, String value);

        /** Milliseconds since boot, counting sleep (SystemClock.elapsedRealtime). */
        long elapsed();

        /** Whether the app may show notifications now (the user allowed them, for the app and its channel). */
        boolean canNotify();

        /** Shows a notification, one per {@code tag}; pressing it opens {@code topicID}. */
        void post(String tag, String title, String body, String topicID);

        /** Runs the watcher's job after {@code delayMs} (0: as soon as there is a network), or cancels it ({@link #STOP}). */
        void schedule(long delayMs);
    }

    /** Whether a job should keep going; the scheduler's stop makes it false. */
    interface Running {
        boolean running();
    }

    private final Platform platform;
    // Whether the app is in front; false in a process the job started.
    private volatile boolean foreground;
    private volatile HttpURLConnection connection;

    TaskNotifier(Platform platform) {
        this.platform = platform;
    }

    /* ---------- what the app says ---------- */

    /**
     * The app's settings: {@code api} (the console server's API address, `https://host/api`),
     * {@code token} (its session; empty when signed out) and {@code texts} (untitled, done, failed,
     * channel). Signing out, or another server, ends the watch.
     */
    synchronized void configure(Map<?, ?> args) {
        String api = trimSlash(MultipartUpload.text(args.get("api")).trim());
        String token = MultipartUpload.text(args.get("token")).trim();
        if (!api.startsWith("http://") && !api.startsWith("https://")) api = "";
        String previousAPI = value(API);
        if (!api.equals(previousAPI) || !token.equals(value(TOKEN))) {
            // Another server or session: its cursor means nothing, and the watch starts over.
            platform.put(EPOCH, null);
            platform.put(CURSOR, null);
        }
        platform.put(API, api.isEmpty() ? null : api);
        platform.put(TOKEN, token.isEmpty() ? null : token);
        Map<?, ?> texts = Json.object(args.get("texts"));
        putText(TEXT_UNTITLED, texts.get("untitled"));
        putText(TEXT_DONE, texts.get("done"));
        putText(TEXT_FAILED, texts.get("failed"));
        putText(TEXT_CHANNEL, texts.get("channel"));
        if (!configured()) stopWatching();
    }

    /** The app came to the front: nothing is told while it is there. */
    synchronized void foreground() {
        foreground = true;
        stopWatching();
    }

    /** The app left the front: watch from now, if there is a session and notifications are allowed. */
    synchronized void background() {
        foreground = false;
        if (!configured() || !platform.canNotify()) {
            stopWatching();
            return;
        }
        platform.put(AWAY_SINCE, Long.toString(platform.elapsed()));
        // The completions while the app was in front were the app's to show: start at the leaving.
        platform.put(EPOCH, null);
        platform.put(CURSOR, null);
        platform.put(RETRIES, null);
        platform.schedule(0);
    }

    boolean isForeground() {
        return foreground;
    }

    /** A pressed notification: the topic the app opens when it is back. */
    synchronized void opened(String topicID) {
        platform.put(OPENED, topicID == null || topicID.trim().isEmpty() ? null : topicID.trim());
    }

    /** The topic of the notification pressed last, once; "" when none is waiting. */
    synchronized String takeOpened() {
        String topicID = value(OPENED);
        platform.put(OPENED, null);
        return topicID;
    }

    boolean hasOpened() {
        return !value(OPENED).isEmpty();
    }

    /* ---------- the job ---------- */

    /**
     * One job's work: asks the server until the budget is spent, the server has nothing left
     * running, or the job is stopped. Returns when the next job should run, or {@link #STOP}.
     */
    long work(long budgetMs, Running job) {
        long start = platform.elapsed();
        while (job.running()) {
            Next next = poll(WAIT_SECONDS);
            // Stopped by the scheduler while asking (the request was cut): it runs the job again itself.
            if (!job.running()) return STOP;
            switch (next) {
                case AGAIN:
                    if (platform.elapsed() - start + WAIT_SECONDS * 1000L > budgetMs) return 0;
                    continue;
                case LATER:
                    return IDLE_DELAY_MS;
                case RETRY:
                    return retryDelay();
                default:
                    return STOP;
            }
        }
        // Stopped by the scheduler: it runs the job again itself.
        return STOP;
    }

    /** Ends a request under way (the job was stopped). */
    void abort() {
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
    }

    enum Next {
        /** Ask again now: something runs, or a completion just came. */
        AGAIN,
        /** Nothing runs on the server: check again later. */
        LATER,
        /** The server could not be reached: try again after a pause. */
        RETRY,
        /** Nothing to watch: in front, signed out, notifications off, or away too long. */
        STOP,
    }

    /** One request for the completions since the last one, telling each new one. */
    Next poll(int waitSeconds) {
        String api;
        String token;
        String query;
        synchronized (this) {
            if (foreground) return Next.STOP;
            if (!configured()) return stopped();
            long away = awayFor();
            if (away < 0 || away > WATCH_LIMIT_MS || !platform.canNotify()) return stopped();
            api = value(API);
            token = value(TOKEN);
            StringBuilder q = new StringBuilder("?wait=").append(Math.max(0, waitSeconds)).append("&since_ms=").append(away);
            String epoch = value(EPOCH);
            String cursor = value(CURSOR);
            if (!epoch.isEmpty() && !cursor.isEmpty()) q.append("&epoch=").append(encode(epoch)).append("&after=").append(encode(cursor));
            query = q.toString();
        }
        Response response;
        try {
            response = get(api + "/notifications/events" + query, token, (waitSeconds + 15) * 1000);
        } catch (IOException e) {
            return Next.RETRY;
        }
        List<Map<?, ?>> fresh = new ArrayList<>();
        boolean active;
        synchronized (this) {
            // Configured anew while asking: ask again with the new settings.
            if (!token.equals(value(TOKEN)) || !api.equals(value(API))) return Next.AGAIN;
            if (response.status == 401 || response.status == 403) {
                // The session ended: the app signs in again and configures a new one.
                platform.put(TOKEN, null);
                return stopped();
            }
            if (response.status >= 400 && response.status < 500) {
                // A server without the events (an older console): asking again changes nothing.
                return stopped();
            }
            if (response.status != 200) return Next.RETRY;
            Map<?, ?> page;
            try {
                page = Json.object(Json.parse(response.body));
            } catch (IllegalArgumentException e) {
                return Next.RETRY;
            }
            platform.put(RETRIES, null);
            String epoch = Json.string(page.get("epoch"));
            long cursor = Json.number(page.get("cursor"), -1);
            if (!epoch.isEmpty() && cursor >= 0) {
                platform.put(EPOCH, epoch);
                platform.put(CURSOR, Long.toString(cursor));
            }
            for (Object event : Json.array(page.get("events"))) fresh.add(Json.object(event));
            active = Json.number(page.get("active"), 0) > 0;
        }
        // Outside the lock: reading a topic's name takes a request, and the app's calls must not wait.
        for (Map<?, ?> event : fresh) deliver(event, api, token);
        if (foreground) return Next.STOP;
        return !fresh.isEmpty() || active ? Next.AGAIN : Next.LATER;
    }

    /**
     * Tells one completion, once per device: the same checks as the web console's, with its
     * consumed IDs kept across restarts (also those suppressed because the app was in front).
     */
    private void deliver(Map<?, ?> event, String api, String token) {
        String id = Json.string(event.get("id")).trim();
        String topicID = Json.string(event.get("topic_id")).trim();
        String status = Json.string(event.get("status"));
        if (!"topic_task_completed".equals(event.get("type")) || id.isEmpty() || topicID.isEmpty()) return;
        if (!"done".equals(status) && !"failed".equals(status)) return;
        // A TODO item's scheduled run never notifies (the server leaves it out already).
        if ("cron".equals(Json.string(event.get("trigger")).trim())) return;
        if (!claim(id)) return;
        if (foreground || !platform.canNotify()) return;
        String title = topicTitle(api, token, topicID);
        if (foreground) return;
        String body = value("done".equals(status) ? TEXT_DONE : TEXT_FAILED);
        if (body.isEmpty()) body = "done".equals(status) ? "Task finished" : "Task failed";
        try {
            platform.post(id, title, body, topicID);
        } catch (RuntimeException e) {
            // A refused notification is not the task's failure, nor the watcher's.
        }
    }

    /** Whether {@code id} is new here; it is remembered either way. */
    synchronized boolean claim(String id) {
        List<String> delivered = new ArrayList<>();
        for (String item : value(DELIVERED).split("\n")) {
            if (!item.isEmpty()) delivered.add(item);
        }
        if (delivered.contains(id)) return false;
        delivered.add(id);
        while (delivered.size() > DELIVERED_LIMIT) delivered.remove(0);
        platform.put(DELIVERED, String.join("\n", delivered));
        return true;
    }

    // The topic's name, as the sidebar shows it; a name that cannot be read in time gives the
    // untitled label, never the topic's ID.
    private String topicTitle(String api, String token, String topicID) {
        String title = "";
        try {
            String uri = "/topics/" + encode(topicID);
            Response response = get(api + "/proxy?endpoint=ep_console_local&uri=" + encode(uri), token, TITLE_TIMEOUT_MS);
            if (response.status == 200) title = Json.string(Json.object(Json.parse(response.body)).get("title")).trim();
        } catch (IOException | IllegalArgumentException e) {
            title = "";
        }
        if (!title.isEmpty()) return title;
        String untitled = value(TEXT_UNTITLED);
        return untitled.isEmpty() ? "Untitled" : untitled;
    }

    /* ---------- state ---------- */

    private boolean configured() {
        return !value(API).isEmpty() && !value(TOKEN).isEmpty();
    }

    private long awayFor() {
        try {
            long since = Long.parseLong(value(AWAY_SINCE));
            long away = platform.elapsed() - since;
            // A clock before the leaving: the phone restarted, and its jobs with it.
            return away < 0 ? -1 : away;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    // Inside the job: the job ends by itself (work returns STOP), so nothing is cancelled here.
    private Next stopped() {
        clearWatch();
        return Next.STOP;
    }

    private synchronized long retryDelay() {
        int retries;
        try {
            retries = Integer.parseInt(value(RETRIES));
        } catch (NumberFormatException e) {
            retries = 0;
        }
        platform.put(RETRIES, Integer.toString(retries + 1));
        long delay = RETRY_FIRST_MS << Math.min(retries, 10);
        return Math.min(delay, RETRY_MAX_MS);
    }

    private void clearWatch() {
        platform.put(AWAY_SINCE, null);
        platform.put(RETRIES, null);
    }

    private void stopWatching() {
        clearWatch();
        platform.schedule(STOP);
    }

    private String value(String key) {
        String value = platform.get(key);
        return value == null ? "" : value;
    }

    private void putText(String key, Object value) {
        String text = MultipartUpload.text(value).trim();
        if (!text.isEmpty()) platform.put(key, text);
    }

    private static String trimSlash(String value) {
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /* ---------- HTTP ---------- */

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private Response get(String address, String token, int timeoutMs) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        connection = conn;
        try {
            conn.setConnectTimeout(Math.min(CONNECT_TIMEOUT_MS, timeoutMs));
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            return new Response(status, in == null ? "" : read(in));
        } finally {
            conn.disconnect();
            if (connection == conn) connection = null;
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            // The answers are small; a larger one is not one of the server's.
            while ((n = input.read(buffer)) > 0) {
                out.write(buffer, 0, n);
                if (out.size() > 1 << 20) throw new IOException("answer too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
