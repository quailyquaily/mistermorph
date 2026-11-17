package com.mistermorph.console;

import java.util.HashMap;
import java.util.Map;

/**
 * The installed app's own version, the answer to the console's `morph.shell.info` host call
 * (lib/mobileHost.ts): Android's version name and version code of this package, which
 * scripts/build-android.sh sets from VERSION (0.3.80 is version code 3080). The console shows it as
 * the shell's version, apart from the connected server's.
 */
final class ShellInfo {
    private ShellInfo() {}

    /** `{version, build}`: the version name ("" when the package has none) and the version code ("" when not positive). */
    static Map<String, Object> describe(String versionName, long versionCode) {
        Map<String, Object> info = new HashMap<>();
        info.put("version", versionName == null ? "" : versionName.trim());
        info.put("build", versionCode > 0 ? Long.toString(versionCode) : "");
        return info;
    }
}
