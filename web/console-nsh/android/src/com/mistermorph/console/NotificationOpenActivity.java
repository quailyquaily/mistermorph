package com.mistermorph.console;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * What a pressed task notification starts: it keeps the topic for the app to open (the app takes it
 * with `morph.notify.take` once it runs) and brings the app to the front as its launcher icon would,
 * starting it when Android had ended it. It shows nothing.
 */
public final class NotificationOpenActivity extends Activity {
    static final String TOPIC = "topic_id";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        String topicID = intent == null ? null : intent.getStringExtra(TOPIC);
        AndroidTaskNotifications.notifier(this).opened(topicID);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            try {
                startActivity(launch);
            } catch (RuntimeException e) {
                // Nothing to open: the topic waits for the next start.
            }
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
