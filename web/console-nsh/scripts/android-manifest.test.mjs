// node --test scripts/android-manifest.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPLICATION, PERMISSION_ACTIVITY, patchManifest } from "./android-manifest.mjs";

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
