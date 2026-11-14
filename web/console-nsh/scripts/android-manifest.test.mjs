// node --test scripts/android-manifest.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLICATION,
  LABEL,
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

test("adds the network-state permission the watcher's network-constrained job needs", () => {
  const out = patchManifest(NSH_MANIFEST);
  // Android 14+ refuses to schedule a job with a network constraint without it (targeting API 34+).
  assert.match(out, /<uses-permission android:name="android\.permission\.ACCESS_NETWORK_STATE" \/>/);
  assert.ok(out.indexOf("ACCESS_NETWORK_STATE") < out.indexOf("<application"));
  assert.equal(out.split("android.permission.ACCESS_NETWORK_STATE").length, 2);
  // Patching again adds it no second time.
  assert.equal(patchManifest(out).split("android.permission.ACCESS_NETWORK_STATE").length, 2);
});

test("keeps a network-state permission the manifest declares already", () => {
  const declared = NSH_MANIFEST.replace(
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    ' +
      '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
  );
  const out = patchManifest(declared);
  assert.equal(out.split("android.permission.ACCESS_NETWORK_STATE").length, 2);
  // Its other additions still come.
  assert.match(out, /android\.permission\.POST_NOTIFICATIONS/);
  assert.ok(out.includes(NOTIFIER_JOB));
  assert.equal(patchManifest(out), out);
});

test("is idempotent and keeps what nsh already declares", () => {
  const once = patchManifest(NSH_MANIFEST);
  assert.equal(patchManifest(once), once);
  const dev = NSH_MANIFEST.replace("<application ", '<application android:usesCleartextTraffic="true" ');
  assert.equal(patchManifest(dev).split("usesCleartextTraffic").length, 2);
});

// Every android:label in the manifest, in order.
const labels = (xml) => [...xml.matchAll(/android:label="([^"]*)"/g)].map((m) => m[1]);

test("names the app Morph in place of nsh.json's name, and nothing else changes", () => {
  assert.equal(LABEL, "Morph");
  const out = patchManifest(NSH_MANIFEST);
  // The application's label is the only one: the launcher activity inherits it.
  assert.deepEqual(labels(out), ["Morph"]);
  assert.ok(!out.includes("Mister Morph"));
  assert.match(out, /<application [^>]*android:label="Morph" android:icon="@mipmap\/ic_launcher"\n/);
  // The package, the icon, the theme and the launcher stay nsh's.
  assert.match(out, /<manifest [^>]*package="com\.mistermorph\.console">/);
  assert.equal(out.split('package="').length, 2);
  assert.match(out, /android:theme="@android:style\/Theme\.Material\.Light\.NoActionBar">/);
  assert.match(out, /<activity android:name="com\.longbridge\.nsh\.AppActivity" android:exported="true"\n/);
  assert.equal(patchManifest(out), out);
});

test("takes the place of a string resource label, and adds one where there is none", () => {
  for (const manifest of [
    NSH_MANIFEST.replace('android:label="Mister Morph"', 'android:label="@string/app_name"'),
    NSH_MANIFEST.replace('android:label="Mister Morph"', "android:label='@string/app_name'"),
    NSH_MANIFEST.replace(' android:label="Mister Morph"', ""),
  ]) {
    const out = patchManifest(manifest);
    assert.deepEqual(labels(out), ["Morph"]);
    assert.ok(!out.includes("app_name"));
    assert.match(out, /android:icon="@mipmap\/ic_launcher"/);
    assert.equal(patchManifest(out), out);
  }
});

test("relabels a launcher that labels itself, and keeps the other components' labels", () => {
  const manifest = NSH_MANIFEST.replace(
    '<activity android:name="com.longbridge.nsh.AppActivity"',
    '<activity android:label="@string/launcher" android:name="com.longbridge.nsh.AppActivity"',
  )
    .replace("<intent-filter>", '<intent-filter android:label="Mister Morph">')
    .replace(
      "</application>",
      '    <activity-alias android:name=".Alias" android:targetActivity="com.longbridge.nsh.AppActivity"\n' +
        '            android:label="Mister Morph Alias" android:exported="true">\n' +
        '            <intent-filter>\n' +
        '                <action android:name="android.intent.action.MAIN" />\n' +
        '                <category android:name="android.intent.category.LAUNCHER" />\n' +
        "            </intent-filter>\n" +
        "        </activity-alias>\n" +
        '        <activity android:name=".Share" android:label="Share to Mister Morph" android:exported="true">\n' +
        '            <intent-filter android:label="Send to Mister Morph">\n' +
        '                <action android:name="android.intent.action.SEND" />\n' +
        "            </intent-filter>\n" +
        "        </activity>\n" +
        '        <activity-alias android:name=".Other" android:targetActivity=".Share" android:label="Other" />\n' +
        '        <activity android:name=".Settings" android:label="@string/settings" />\n' +
        "    </application>",
    );
  const out = patchManifest(manifest);
  // The application, nsh's activity, its launcher filter and the launcher alias are Morph; the
  // share activity, its filter, the other alias and the settings activity keep their labels.
  assert.deepEqual(labels(out), [
    "Morph",
    "Morph",
    "Morph",
    "Morph",
    "Share to Mister Morph",
    "Send to Mister Morph",
    "Other",
    "@string/settings",
  ]);
  assert.match(out, /<activity android:label="Morph" android:name="com\.longbridge\.nsh\.AppActivity"/);
  assert.match(out, /android:label="Morph" android:exported="true">\n {12}<intent-filter>/);
  assert.equal(out.split("android.intent.category.LAUNCHER").length, 3);
  assert.equal(patchManifest(out), out);
});

test("refuses a manifest it cannot place its parts in", () => {
  assert.throws(() => patchManifest("<manifest></manifest>"), /no <application>/);
  assert.throws(
    () => patchManifest(NSH_MANIFEST.replace("<application ", '<application android:name="com.example.App" ')),
    /names its own Application/,
  );
});
