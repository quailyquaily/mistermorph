// node --test scripts/android-manifest.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLICATION,
  NOTIFICATION_OPEN_ACTIVITY,
  NOTIFICATION_PERMISSION_ACTIVITY,
  NOTIFIER_JOB,
  PERMISSION_ACTIVITY,
  patchManifest,
} from "./android-manifest.mjs";

// The manifest nsh 0.4.0 links for a packaged TSX app (nsh-cli's android.rs).
const NSH_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.mistermorph.console">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="Mister Morph" android:icon="@mipmap/ic_launcher"
        android:extractNativeLibs="false"
        android:enableOnBackInvokedCallback="true"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity android:name="com.longbridge.nsh.AppActivity" android:exported="true"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

test("adds cleartext HTTP, the microphone, the Application and the permission activity", () => {
  const out = patchManifest(NSH_MANIFEST);
  assert.match(out, /<application android:name="com\.mistermorph\.console\.MorphApplication" android:usesCleartextTraffic="true" android:label=/);
  assert.match(out, /<uses-permission android:name="android\.permission\.RECORD_AUDIO" \/>/);
  assert.match(out, /<uses-feature android:name="android\.hardware\.microphone" android:required="false" \/>/);
  // The permission comes before <application>, as the manifest's schema wants.
  assert.ok(out.indexOf("RECORD_AUDIO") < out.indexOf("<application"));
  // The activity sits inside <application>, after nsh's own, which stays the launcher.
  const activity = out.indexOf(PERMISSION_ACTIVITY);
  assert.ok(activity > out.indexOf("com.longbridge.nsh.AppActivity") && activity < out.indexOf("</application>"));
  assert.match(out, /VoicePermissionActivity" android:exported="false"/);
  assert.match(out, /Theme\.Translucent\.NoTitleBar/);
  assert.equal(out.split(APPLICATION).length, 2);
});

test("adds the notification permission, its activities and the watcher's job", () => {
  const out = patchManifest(NSH_MANIFEST);
  assert.match(out, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/);
  assert.ok(out.indexOf("POST_NOTIFICATIONS") < out.indexOf("<application"));
  for (const name of [NOTIFICATION_PERMISSION_ACTIVITY, NOTIFICATION_OPEN_ACTIVITY, NOTIFIER_JOB]) {
    const at = out.indexOf(name);
    assert.ok(at > out.indexOf("com.longbridge.nsh.AppActivity") && at < out.indexOf("</application>"), name);
    assert.equal(out.split(name).length, 2, name);
  }
  // Only JobScheduler may bind the job, and nothing outside the app may start any of them.
  assert.match(out, /TaskNotifierJob" android:exported="false"\s+android:permission="android\.permission\.BIND_JOB_SERVICE"/);
  assert.match(out, /NotificationOpenActivity" android:exported="false"/);
  assert.match(out, /NotificationPermissionActivity" android:exported="false"/);
  assert.match(out, /Theme\.NoDisplay/);
  // nsh's activity stays the only launcher.
  assert.equal(out.split("android.intent.category.LAUNCHER").length, 2);
});

test("is idempotent and keeps what nsh already declares", () => {
  const once = patchManifest(NSH_MANIFEST);
  assert.equal(patchManifest(once), once);
  const dev = NSH_MANIFEST.replace("<application ", '<application android:usesCleartextTraffic="true" ');
  assert.equal(patchManifest(dev).split("usesCleartextTraffic").length, 2);
});

test("refuses a manifest it cannot place its parts in", () => {
  assert.throws(() => patchManifest("<manifest></manifest>"), /no <application>/);
  assert.throws(
    () => patchManifest(NSH_MANIFEST.replace("<application ", '<application android:name="com.example.App" ')),
    /names its own Application/,
  );
});
