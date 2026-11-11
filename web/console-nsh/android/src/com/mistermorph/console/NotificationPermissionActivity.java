package com.mistermorph.console;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;

/**
 * Asks for notifications (Android 13 and newer), as {@link VoicePermissionActivity} asks for the
 * microphone: nsh's AppActivity is final and hears no permission results, so this transparent
 * activity asks over it. Only the Settings page's notifications row asks (morph.notify.request).
 */
public final class NotificationPermissionActivity extends Activity {
    private static final int REQUEST = 2;
    private static final String RATIONALE = "rationale_before";

    interface Callback {
        void done(String state);
    }

    interface OutcomeCallback {
        void done(VoicePermission.Outcome outcome);
    }

    // The request waiting for an answer; UI thread only.
    private static OutcomeCallback pending;

    private boolean rationaleBefore;
    private OutcomeCallback callback;

    static void request(Activity from, OutcomeCallback callback) {
        // One question at a time: an older one that never came back counts as refused.
        deliver(VoicePermission.Outcome.DENIED);
        pending = callback;
        Intent intent = new Intent(from, NotificationPermissionActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        try {
            from.startActivity(intent);
        } catch (RuntimeException e) {
            deliver(VoicePermission.Outcome.DENIED);
        }
    }

    private static void deliver(VoicePermission.Outcome outcome) {
        OutcomeCallback current = pending;
        pending = null;
        if (current != null) current.done(outcome);
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
            finish();
            return;
        }
        if (state != null) {
            rationaleBefore = state.getBoolean(RATIONALE);
            return;
        }
        rationaleBefore = shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS);
        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST);
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
            answer(VoicePermission.Outcome.DENIED);
        } else {
            boolean granted = results[0] == PackageManager.PERMISSION_GRANTED;
            SharedPreferences preferences = getSharedPreferences(AndroidTaskNotifications.PREFERENCES, MODE_PRIVATE);
            boolean askedBefore = preferences.getBoolean(AndroidTaskNotifications.ASKED, false);
            preferences.edit().putBoolean(AndroidTaskNotifications.ASKED, true).apply();
            boolean rationaleAfter = shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS);
            answer(VoicePermission.decide(granted, rationaleBefore, rationaleAfter, askedBefore));
        }
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) answer(VoicePermission.Outcome.DENIED);
        super.onDestroy();
    }
}
