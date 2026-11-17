package com.mistermorph.console;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Downloads what the console serves at a URL into a stream, for `morph.file.save`: a GET with the
 * headers the app gave (its session's bearer token), the bytes copied as they come. Only http(s),
 * and redirects are never followed: the headers go to that URL alone, and a redirect fails the
 * download instead of taking them elsewhere. A body shorter than its Content-Length fails too.
 */
final class FileDownload {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    // An error's body is read for its message only.
    private static final int MAX_ERROR_BODY = 16 * 1024;

    private final URL url;
    private final Map<String, String> headers;

    FileDownload(URL url, Map<String, String> headers) {
        String scheme = url.getProtocol();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("not an http(s) URL");
        }
        this.url = url;
        this.headers = headers;
    }

    /** Why a download failed, in words the console shows. */
    static final class Failure extends IOException {
        final int status;

        Failure(String message, int status) {
            super(message);
            this.status = status;
        }
    }

    /** Copies the body into {@code out}; the number of bytes written. */
    long into(OutputStream out) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setUseCaches(false);
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                conn.setRequestProperty(entry.getKey(), entry.getValue());
            }
            int status = conn.getResponseCode();
            if (status >= 300 && status < 400) {
                throw new Failure("The server redirected the download (HTTP " + status + "); it was not followed.", status);
            }
            if (status < 200 || status >= 300) {
                throw new Failure(errorMessage(status, conn.getErrorStream()), status);
            }
            long expected = conn.getContentLengthLong();
            long written = 0;
            try (InputStream in = conn.getInputStream()) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    written += read;
                }
            }
            if (expected >= 0 && written != expected) {
                throw new Failure("The download ended early (" + written + " of " + expected + " bytes).", status);
            }
            return written;
        } finally {
            conn.disconnect();
        }
    }

    /** The server's `error` (its JSON answers carry one), else its short text, else the status. */
    static String errorMessage(int status, InputStream body) {
        String text = "";
        if (body != null) {
            try (InputStream in = body) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int read;
                while (bytes.size() < MAX_ERROR_BODY && (read = in.read(buffer)) != -1) bytes.write(buffer, 0, read);
                text = new String(bytes.toByteArray(), StandardCharsets.UTF_8).trim();
            } catch (IOException e) {
                text = "";
            }
        }
        String message = "";
        if (text.startsWith("{")) {
            try {
                message = Json.string(Json.object(Json.parse(text)).get("error")).trim();
            } catch (IllegalArgumentException e) {
                message = "";
            }
        } else if (!text.isEmpty() && text.length() <= 200 && !text.startsWith("<")) {
            message = text;
        }
        return message.isEmpty() ? "HTTP " + status : message;
    }
}
