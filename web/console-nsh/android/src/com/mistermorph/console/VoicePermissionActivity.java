package com.mistermorph.console;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;

/**
 * Asks for the microphone. nsh's AppActivity is final and hears no permission results, so this
 * transparent activity asks over it and reports the {@link VoicePermission.Outcome} to the one
 * request waiting. The app below is only paused (nsh's lifecycle "inactive"), never stopped, so the
 * pending recording is not cancelled as leaving the app would cancel it.
 */
public final class VoicePermissionActivity extends Activity {
    private static final int REQUEST = 1;
    private static final String PREFERENCES = "morph_voice";
    private static final String ASKED = "microphone_asked";
    private static final String RATIONALE = "rationale_before";

    // The request waiting for an answer; UI thread only.
    private static VoicePlatform.PermissionCallback pending;

    private boolean rationaleBefore;
    // The request this activity answers: a newer one is not this one's to answer.
    private VoicePlatform.PermissionCallback callback;

    static void request(Activity from, VoicePlatform.PermissionCallback callback) {
        // One question at a time: an older one that never came back counts as refused.
        deliver(VoicePermission.Outcome.DENIED);
        pending = callback;
        Intent intent = new Intent(from, VoicePermissionActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        try {
            from.startActivity(intent);
        } catch (RuntimeException e) {
            deliver(VoicePermission.Outcome.DENIED);
        }
    }

    private static void deliver(VoicePermission.Outcome outcome) {
        VoicePlatform.PermissionCallback callback = pending;
        pending = null;
        if (callback != null) callback.done(outcome);
    }

    private void answer(VoicePermission.Outcome outcome) {
        if (callback != null && pending == callback) deliver(outcome);
        callback = null;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        callback = pending;
        if (callback == null) {
            // Nothing waits (the process was restarted under it): nothing to ask.
            finish();
            return;
        }
        if (state != null) {
            rationaleBefore = state.getBoolean(RATIONALE);
            return;
        }
        rationaleBefore = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO);
        requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQUEST);
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean(RATIONALE, rationaleBefore);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQUEST) return;
        if (results.length == 0) {
            // The request was interrupted: no answer from the user.
            answer(VoicePermission.Outcome.DENIED);
        } else {
            boolean granted = results[0] == PackageManager.PERMISSION_GRANTED;
            SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
            boolean askedBefore = preferences.getBoolean(ASKED, false);
            preferences.edit().putBoolean(ASKED, true).apply();
            boolean rationaleAfter = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO);
            answer(VoicePermission.decide(granted, rationaleBefore, rationaleAfter, askedBefore));
        }
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        // Gone without an answer (closed by the system): the recording does not start.
        if (isFinishing()) answer(VoicePermission.Outcome.DENIED);
        super.onDestroy();
    }
}
