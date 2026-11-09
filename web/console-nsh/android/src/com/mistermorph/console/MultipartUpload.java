package com.mistermorph.console;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Sends a recording where the app's `morph.file.upload` says, as the browser's host does with a
 * `File`: multipart form data with the file under {@code field} (and the extra {@code fields}), or
 * the file itself as the body without a field. The app reads the answer as it reads fetch's.
 * {@link #abort} from another thread ends it.
 */
final class MultipartUpload {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    // Transcription takes a while for a long recording.
    private static final int READ_TIMEOUT_MS = 180_000;

    private final URL url;
    private final String method;
    private final Map<String, String> headers;
    private final String field;
    private final Map<String, String> fields;
    private final File file;
    private final String fileName;
    private final String type;
    private volatile boolean aborted;
    private volatile HttpURLConnection connection;

    MultipartUpload(URL url, String method, Map<String, String> headers, String field, Map<String, String> fields,
            File file, String fileName, String type) {
        String scheme = url.getProtocol();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("not an http(s) URL: " + url);
        }
        this.url = url;
        this.method = method == null || method.isEmpty() ? "POST" : method;
        this.headers = headers;
        this.field = field == null ? "" : field;
        this.fields = fields;
        this.file = file;
        this.fileName = fileName;
        this.type = type;
    }

    /** The upload `morph.file.upload`'s arguments describe: url, method, headers, field, fields. */
    static MultipartUpload from(Map<?, ?> args, File file, String fileName, String type) throws IOException {
        return new MultipartUpload(new URL(text(args.get("url"))), text(args.get("method")), strings(args.get("headers")),
                text(args.get("field")), strings(args.get("fields")), file, fileName, type);
    }

    /** What came back: the status and the body, as text. */
    static final class Result {
        final int status;
        final String statusText;
        final String body;

        Result(int status, String statusText, String body) {
            this.status = status;
            this.statusText = statusText;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("ok", ok());
            map.put("status", status);
            map.put("statusText", statusText);
            map.put("body", body);
            return map;
        }
    }

    boolean aborted() {
        return aborted;
    }

    /** Ends the upload: {@link #send} throws. */
    void abort() {
        aborted = true;
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
    }

    Result send() throws IOException {
        if (aborted) throw new IOException("aborted");
        String boundary = "----MisterMorph" + UUID.randomUUID().toString().replace("-", "");
        byte[] head;
        byte[] tail;
        if (field.isEmpty()) {
            head = new byte[0];
            tail = new byte[0];
        } else {
            StringBuilder text = new StringBuilder();
            for (Map.Entry<String, String> entry : fields.entrySet()) {
                text.append("--").append(boundary).append("\r\n")
                        .append("Content-Disposition: form-data; name=\"").append(quote(entry.getKey())).append("\"\r\n\r\n")
                        .append(entry.getValue()).append("\r\n");
            }
            text.append("--").append(boundary).append("\r\n")
                    .append("Content-Disposition: form-data; name=\"").append(quote(field))
                    .append("\"; filename=\"").append(quote(fileName)).append("\"\r\n")
                    .append("Content-Type: ").append(type).append("\r\n\r\n");
            head = text.toString().getBytes(StandardCharsets.UTF_8);
            tail = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        }
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        connection = conn;
        try {
            if (aborted) throw new IOException("aborted");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod(method);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            boolean typed = false;
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                conn.setRequestProperty(entry.getKey(), entry.getValue());
                typed |= "content-type".equalsIgnoreCase(entry.getKey());
            }
            if (!field.isEmpty()) {
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            } else if (!typed) {
                conn.setRequestProperty("Content-Type", type);
            }
            conn.setFixedLengthStreamingMode(head.length + file.length() + tail.length);
            try (OutputStream out = conn.getOutputStream(); InputStream in = new FileInputStream(file)) {
                out.write(head);
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (aborted) throw new IOException("aborted");
                    out.write(buffer, 0, read);
                }
                out.write(tail);
            }
            int status = conn.getResponseCode();
            String statusText = conn.getResponseMessage();
            InputStream body = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            return new Result(status, statusText == null ? "" : statusText, read(body));
        } catch (IOException e) {
            if (aborted) throw new IOException("aborted", e);
            throw e;
        } finally {
            conn.disconnect();
            connection = null;
        }
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream stream = in) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = stream.read(buffer)) > 0) bytes.write(buffer, 0, read);
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String quote(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", " ").replace("\n", " ");
    }

    static String text(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static Map<String, String> strings(Object value) {
        Map<String, String> map = new LinkedHashMap<>();
        if (value instanceof Map) {
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null) {
                    map.put(String.valueOf(entry.getKey()), String.valueOf(entry.getValue()));
                }
            }
        }
        return map;
    }
}
