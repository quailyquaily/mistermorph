package com.mistermorph.console;

import java.io.IOException;
import java.io.OutputStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Saves a file where the user chooses, for the console's `morph.file.save` in the phone app (nsh
 * has no save dialog on Android): the system's picker for a new document opens with the file's
 * name, and once the user chose a place the bytes are written there: text or base64 the app has, or
 * what the console serves at a URL ({@link FileDownload}, with the app's headers). It answers
 * "saved" only once every byte is written, "cancelled" when the user backed out of the picker, and
 * fails with what went wrong; a document the picker made for a save that failed is deleted, so no
 * partial file is left behind. One picker at a time.
 *
 * <p>No Android here: {@link Platform} is the system's part (AndroidFileSavePlatform), so the JVM
 * tests run it on a fake one.
 */
final class FileSaver {
    static final String DEFAULT_NAME = "download";
    static final String BINARY = "application/octet-stream";

    /** The system's part. */
    interface Platform {
        /** Whether the system has a picker for new documents. */
        boolean canPickDestination();

        /** Shows the picker for a new document named {@code name} of type {@code mime}. */
        void pickDestination(String name, String mime, DestinationCallback callback);

        /** Opens the chosen document for writing. */
        OutputStream open(Object destination) throws IOException;

        /** Deletes the chosen document (a failed save's). */
        void discard(Object destination);

        /** The MIME type of a lower-case file extension, or null. */
        String mimeForExtension(String extension);

        void runInBackground(Runnable task);
    }

    interface DestinationCallback {
        /** The document the user chose (and the picker made). */
        void picked(Object destination);

        /** The user backed out. */
        void cancelled();

        /** The picker could not be shown. */
        void failed(String message);
    }

    interface Reply {
        void resolve(Object value);

        void reject(String message);
    }

    private final Platform platform;
    // Whether a picker is open; the UI thread's.
    private boolean picking;

    FileSaver(Platform platform) {
        this.platform = platform;
    }

    /** "" when the app can save files, else why not ("unsupported": no picker for new documents). */
    String support() {
        return platform.canPickDestination() ? "" : "unsupported";
    }

    /** What one `morph.file.save` asks for, checked. */
    static final class Request {
        final String name;
        final String mime;
        final byte[] bytes;
        final URL url;
        final Map<String, String> headers;

        Request(String name, String mime, byte[] bytes, URL url, Map<String, String> headers) {
            this.name = name;
            this.mime = mime;
            this.bytes = bytes;
            this.url = url;
            this.headers = headers;
        }
    }

    /** Reads `morph.file.save`'s arguments: name, and text, base64 or url (with headers). */
    Request request(Map<?, ?> args) {
        String name = safeName(MultipartUpload.text(args.get("name")));
        String mime = mimeFor(name);
        Object text = args.get("text");
        Object base64 = args.get("base64");
        if (text instanceof String) {
            return new Request(name, mime, ((String) text).getBytes(StandardCharsets.UTF_8), null, null);
        }
        if (base64 instanceof String) {
            byte[] bytes;
            try {
                bytes = Base64.getDecoder().decode(((String) base64).trim());
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("The file's contents are not valid base64.");
            }
            return new Request(name, mime, bytes, null, null);
        }
        String address = MultipartUpload.text(args.get("url"));
        if (address.isEmpty()) throw new IllegalArgumentException("Nothing to save.");
        URL url;
        try {
            url = new URL(address);
        } catch (MalformedURLException e) {
            throw new IllegalArgumentException("The file's address is not an http(s) URL.");
        }
        String scheme = url.getProtocol();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("The file's address is not an http(s) URL.");
        }
        return new Request(name, mime, null, url, strings(args.get("headers")));
    }

    /** Saves what `args` describes where the user chooses; see the class. UI thread. */
    void save(Map<?, ?> args, Reply reply) {
        Request request;
        try {
            request = request(args);
        } catch (IllegalArgumentException e) {
            reply.reject(e.getMessage());
            return;
        }
        if (picking) {
            reply.reject("Another file is waiting for a place to be saved.");
            return;
        }
        picking = true;
        platform.pickDestination(request.name, request.mime, new DestinationCallback() {
            private boolean answered;

            @Override
            public void picked(Object destination) {
                if (!settle()) return;
                try {
                    platform.runInBackground(() -> write(request, destination, reply));
                } catch (RuntimeException e) {
                    // The app is closing (its save thread is gone): nothing will be written.
                    platform.discard(destination);
                    reply.reject("The file could not be written: " + detail(e));
                }
            }

            @Override
            public void cancelled() {
                if (settle()) reply.resolve("cancelled");
            }

            @Override
            public void failed(String message) {
                if (settle()) reply.reject(message);
            }

            private boolean settle() {
                if (answered) return false;
                answered = true;
                picking = false;
                return true;
            }
        });
    }

    private void write(Request request, Object destination, Reply reply) {
        try {
            OutputStream out;
            try {
                out = platform.open(destination);
            } catch (IOException | RuntimeException e) {
                throw new WriteFailure(e);
            }
            try {
                OutputStream target = new Writes(out);
                if (request.bytes != null) {
                    target.write(request.bytes);
                } else {
                    new FileDownload(request.url, request.headers).into(target);
                }
                target.flush();
            } finally {
                // A provider may only store the document as it is closed: that failing is the save failing.
                try {
                    out.close();
                } catch (IOException | RuntimeException e) {
                    throw new WriteFailure(e);
                }
            }
        } catch (WriteFailure e) {
            platform.discard(destination);
            reply.reject("The file could not be written: " + e.getMessage());
            return;
        } catch (FileDownload.Failure e) {
            platform.discard(destination);
            reply.reject(e.getMessage());
            return;
        } catch (IOException | RuntimeException e) {
            platform.discard(destination);
            reply.reject("The download failed: " + detail(e));
            return;
        }
        reply.resolve("saved");
    }

    private static String detail(Throwable e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }

    /** Writing to (or opening, or closing) the chosen document failed. */
    static final class WriteFailure extends IOException {
        WriteFailure(Throwable cause) {
            super(detail(cause), cause);
        }
    }

    /** The chosen document's stream, whose failures are {@link WriteFailure}s. */
    private static final class Writes extends OutputStream {
        private final OutputStream out;

        Writes(OutputStream out) {
            this.out = out;
        }

        @Override
        public void write(int b) throws IOException {
            try {
                out.write(b);
            } catch (IOException | RuntimeException e) {
                throw new WriteFailure(e);
            }
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            try {
                out.write(b, off, len);
            } catch (IOException | RuntimeException e) {
                throw new WriteFailure(e);
            }
        }

        @Override
        public void flush() throws IOException {
            try {
                out.flush();
            } catch (IOException | RuntimeException e) {
                throw new WriteFailure(e);
            }
        }
    }

    /**
     * The name the picker offers: the file's own, without what no file name can hold (path
     * separators, control characters), or {@link #DEFAULT_NAME}.
     */
    static String safeName(String raw) {
        StringBuilder out = new StringBuilder();
        String text = raw == null ? "" : raw;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '/' || c == '\\' || c < 0x20 || c == 0x7f) out.append('_');
            else out.append(c);
        }
        String name = out.toString().trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return DEFAULT_NAME;
        return name;
    }

    /**
     * The type the picker is given: the one of the name's extension, so the system's provider keeps
     * the name as it is (given another type it may add that type's extension), or plain bytes.
     */
    String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return BINARY;
        String mime = platform.mimeForExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return mime == null || mime.isEmpty() ? BINARY : mime;
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
