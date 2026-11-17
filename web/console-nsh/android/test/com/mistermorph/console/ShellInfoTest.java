package com.mistermorph.console;

import java.util.Map;

/** Runs on the JDK alone (scripts/android-host.sh test): what `morph.shell.info` answers. */
public final class ShellInfoTest {
    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    public static void main(String[] args) {
        Map<String, Object> release = ShellInfo.describe(" 0.3.80 ", 3080);
        check("0.3.80".equals(release.get("version")), "the version name, trimmed: " + release);
        check("3080".equals(release.get("build")), "the version code as text: " + release);

        Map<String, Object> missing = ShellInfo.describe(null, 0);
        check("".equals(missing.get("version")), "no version name is empty, never another version: " + missing);
        check("".equals(missing.get("build")), "no version code is empty: " + missing);

        Map<String, Object> big = ShellInfo.describe("12.0.1", 12000001L);
        check("12000001".equals(big.get("build")), "long version codes: " + big);
        System.out.println("ShellInfoTest: ok");
    }
}
