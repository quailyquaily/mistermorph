// What the phone app adds to the AndroidManifest.xml `nsh package` writes (build-android.sh's aapt2
// shim runs this on the manifest before aapt2 links it):
//
// - cleartext HTTP: the console server is usually plain http:// on the local network, and nsh
//   declares `android:usesCleartextTraffic` only for its development builds;
// - voice input (android/src): the microphone permission (asked at the first recording), the
//   Application that answers `morph.voice.*` (MorphApplication) and the transparent activity that
//   asks for the permission. A microphone is not required to install the app.
// - task notifications (android/src, TaskNotifier): the notification permission (asked only from
//   Settings' notifications row), the job that watches the server while the app is away, the
//   transparent activity that asks for the permission and the one a pressed notification starts.
//
//   node scripts/android-manifest.mjs AndroidManifest.xml     patches the file in place
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const APPLICATION = "com.mistermorph.console.MorphApplication";
export const PERMISSION_ACTIVITY = "com.mistermorph.console.VoicePermissionActivity";
export const NOTIFICATION_PERMISSION_ACTIVITY = "com.mistermorph.console.NotificationPermissionActivity";
export const NOTIFICATION_OPEN_ACTIVITY = "com.mistermorph.console.NotificationOpenActivity";
export const NOTIFIER_JOB = "com.mistermorph.console.TaskNotifierJob";
// The configuration changes nsh's own activity handles, so a rotation does not restart the question.
const CONFIG_CHANGES =
  "orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode|density|fontScale|locale|layoutDirection";

/** The manifest with the phone app's additions; a manifest that has them already comes back unchanged. */
export function patchManifest(xml) {
  let out = String(xml);
  if (!/<application\b/.test(out) || !/<\/application>/.test(out)) {
    throw new Error("the manifest has no <application>: did nsh change the manifest it links?");
  }
  if (!out.includes("usesCleartextTraffic")) {
    out = out.replace(/<application\b/, '<application android:usesCleartextTraffic="true"');
  }
  if (!out.includes("android.permission.RECORD_AUDIO")) {
    out = out.replace(
      /<application\b/,
      '<uses-permission android:name="android.permission.RECORD_AUDIO" />\n    ' +
        '<uses-feature android:name="android.hardware.microphone" android:required="false" />\n    <application',
    );
  }
  if (!out.includes("android.permission.POST_NOTIFICATIONS")) {
    out = out.replace(/<application\b/, '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <application');
  }
  if (!out.includes(APPLICATION)) {
    if (/<application\b[^>]*\sandroid:name=/.test(out)) {
      throw new Error("the manifest names its own Application: MorphApplication cannot replace it");
    }
    out = out.replace(/<application\b/, `<application android:name="${APPLICATION}"`);
  }
  if (!out.includes(PERMISSION_ACTIVITY)) {
    out = out.replace(
      /<\/application>/,
      `    <activity android:name="${PERMISSION_ACTIVITY}" android:exported="false"\n` +
        `            android:theme="@android:style/Theme.Translucent.NoTitleBar"\n` +
        `            android:excludeFromRecents="true"\n` +
        `            android:configChanges="${CONFIG_CHANGES}" />\n    </application>`,
    );
  }
  if (!out.includes(NOTIFICATION_PERMISSION_ACTIVITY)) {
    out = out.replace(
      /<\/application>/,
      `    <activity android:name="${NOTIFICATION_PERMISSION_ACTIVITY}" android:exported="false"\n` +
        `            android:theme="@android:style/Theme.Translucent.NoTitleBar"\n` +
        `            android:excludeFromRecents="true"\n` +
        `            android:configChanges="${CONFIG_CHANGES}" />\n    </application>`,
    );
  }
  if (!out.includes(NOTIFICATION_OPEN_ACTIVITY)) {
    // Started by a pressed notification only; it brings nsh's activity back and shows nothing.
    out = out.replace(
      /<\/application>/,
      `    <activity android:name="${NOTIFICATION_OPEN_ACTIVITY}" android:exported="false"\n` +
        `            android:theme="@android:style/Theme.NoDisplay"\n` +
        `            android:excludeFromRecents="true" android:noHistory="true"\n` +
        `            android:taskAffinity="" />\n    </application>`,
    );
  }
  if (!out.includes(NOTIFIER_JOB)) {
    out = out.replace(
      /<\/application>/,
      `    <service android:name="${NOTIFIER_JOB}" android:exported="false"\n` +
        `            android:permission="android.permission.BIND_JOB_SERVICE" />\n    </application>`,
    );
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/android-manifest.mjs AndroidManifest.xml");
    process.exit(1);
  }
  writeFileSync(file, patchManifest(readFileSync(file, "utf8")));
}
