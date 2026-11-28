package com.longbridge.nsh;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Reading a pasted image's bytes from its content URI within a bound (InputBox, patched for
 * FT197). nsh 0.6.0 read the whole stream, however large, into memory. The bounds are the
 * console's: an upload takes at most 128 MiB a file (internal/daemonruntime upload_limits.go) and
 * a paste at most 256 MiB of images (web/console-nsh/components/chat/uploads.ts), so more is never
 * read. They bound what is read, not what the device can spare: a large image still takes its
 * size in memory, and a failed allocation is told as unreadable.
 */
public final class PasteReads {
    private PasteReads() {}

    /** The most bytes of one pasted image read. */
    public static final long MAX_IMAGE_BYTES = 128L * 1024 * 1024;

    /** The most bytes of one paste's images read together. */
    public static final long MAX_BATCH_BYTES = 256L * 1024 * 1024;

    /** Whether a size a provider declares is over the bound (-1, unknown, is not). */
    public static boolean tooLarge(long declared) {
        return declared > MAX_IMAGE_BYTES;
    }

    /**
     * The bytes of `in`, or null when it holds more than `max` (read no further than one chunk past
     * it). The stream is the caller's to close.
     */
    public static byte[] readAtMost(InputStream in, long max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        for (int n; (n = in.read(buffer)) != -1; ) {
            if (n == 0) continue;
            total += n;
            if (total > max) return null;
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }
}
