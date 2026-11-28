package com.longbridge.nsh;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * A pasted image is read within its bound (PasteReads), and what could not be handed to the app is
 * told to the listener (PasteNotices): run by `scripts/android-host.sh test`.
 */
public final class PasteReadsTest {
    private static int failures;

    private static void check(boolean ok, String what) {
        if (!ok) {
            failures++;
            System.out.println("FAIL " + what);
        }
    }

    /** A stream of `size` bytes that counts what was read of it. */
    private static final class Counted extends InputStream {
        final long size;
        long read;

        Counted(long size) {
            this.size = size;
        }

        @Override
        public int read() {
            if (read >= size) return -1;
            read++;
            return 7;
        }

        @Override
        public int read(byte[] b, int off, int len) {
            if (read >= size) return -1;
            int n = (int) Math.min(len, size - read);
            read += n;
            return n;
        }
    }

    public static void main(String[] args) throws IOException {
        byte[] small = {1, 2, 3};
        byte[] got = PasteReads.readAtMost(new ByteArrayInputStream(small), 3);
        check(got != null && got.length == 3 && got[2] == 3, "a stream of exactly the bound is read whole");
        check(PasteReads.readAtMost(new ByteArrayInputStream(small), 2) == null, "a stream past the bound is refused");
        check(PasteReads.readAtMost(new ByteArrayInputStream(new byte[0]), 2).length == 0, "an empty stream is empty bytes");

        long max = PasteReads.MAX_IMAGE_BYTES;
        check(max == 134_217_728L, "the bound is the upload budget, 128 MiB");
        check(PasteReads.MAX_BATCH_BYTES == 268_435_456L, "a paste's bound is 256 MiB");
        // Exact bounds on a small scale (a 128 MiB array is not what this test should allocate).
        long bound = 3L * 1024 * 1024 + 7;
        Counted exact = new Counted(bound);
        byte[] whole = PasteReads.readAtMost(exact, bound);
        check(whole != null && whole.length == bound, "a stream of exactly the bound is read whole");
        check(PasteReads.readAtMost(new Counted(bound + 1), bound) == null, "one byte past the bound is refused");
        Counted huge = new Counted(1L << 40);
        check(PasteReads.readAtMost(huge, max) == null, "a terabyte stream is refused at 128 MiB");
        check(huge.read <= max + 64 * 1024, "and no more than one chunk past the bound is read of it (read " + huge.read + ")");

        check(!PasteReads.tooLarge(-1), "an unknown declared size is read (within the bound)");
        check(!PasteReads.tooLarge(max), "a declared 128 MiB is read");
        check(PasteReads.tooLarge(max + 1), "a declared size past 128 MiB is not read at all");

        List<String> heard = new ArrayList<>();
        PasteNotices.refused(PasteNotices.TOO_LARGE, 1);
        PasteNotices.Listener listener = (reason, count) -> heard.add(reason + ":" + count);
        PasteNotices.listen(listener);
        PasteNotices.refused(PasteNotices.TOO_LARGE, 2);
        PasteNotices.refused(PasteNotices.UNREADABLE, 0);
        PasteNotices.refused(PasteNotices.UNREADABLE, 1);
        PasteNotices.refused(PasteNotices.BATCH_TOO_LARGE, 2);
        PasteNotices.stop((reason, count) -> heard.add("other"));
        PasteNotices.refused(PasteNotices.UNREADABLE, 1);
        PasteNotices.stop(listener);
        PasteNotices.refused(PasteNotices.UNREADABLE, 1);
        check(heard.toString().equals("[too_large:2, unreadable:1, batch_too_large:2, unreadable:1]"), "the listener hears refusals while it listens, none of 0 (" + heard + ")");

        if (failures > 0) {
            System.out.println(failures + " checks failed");
            System.exit(1);
        }
        System.out.println("PasteReadsTest: all checks passed");
    }
}
