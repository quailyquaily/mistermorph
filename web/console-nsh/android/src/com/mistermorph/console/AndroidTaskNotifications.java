package com.mistermorph.console;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;

/**
 * Android's part of {@link TaskNotifier}: its saved values (SharedPreferences, private to the app),
 * the clock, the notifications (one channel) and the job ({@link TaskNotifierJob}). One per
 * process, made by {@link #notifier}.
 */
final class AndroidTaskNotifications implements TaskNotifier.Platform {
    static final int JOB_ID = 4701;
    static final String CHANNEL = "topic_tasks";
    static final String PREFERENCES = "morph_task_notifications";
    // Whether the app asked for notifications before (a boolean beside the watcher's strings).
    static final String ASKED = "permission_asked";

    private static TaskNotifier notifier;

    private final Context context;
    private final SharedPreferences preferences;

    private AndroidTaskNotifications(Context context) {
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static synchronized TaskNotifier notifier(Context context) {
        if (notifier == null) notifier = new TaskNotifier(new AndroidTaskNotifications(context));
        return notifier;
    }

    /* ---------- permission ---------- */

    private static boolean needsRuntimePermission() {
        return Build.VERSION.SDK_INT >= 33;
    }

    private static boolean hasRuntimePermission(Context context) {
        return !needsRuntimePermission()
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** Whether the user allows the app's notifications, and has not turned its channel off. */
    static boolean allowed(Context context) {
        if (!hasRuntimePermission(context)) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /**
     * The permission as the console names it (lib/platform.ts): "granted", "default" (the app may
     * ask) or "denied" (only the system's Settings can change it).
     */
    static String state(Activity activity) {
        if (allowed(activity)) return "granted";
        if (needsRuntimePermission() && !hasRuntimePermission(activity)) {
            boolean asked = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(ASKED, false);
            // Before the first question, and while the system would still ask again, the app may ask.
            if (!asked || activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) return "default";
        }
        return "denied";
    }

    /** Asks for notifications where Android asks (13 and newer); {@code callback} hears the state after it. */
    static void request(Activity activity, NotificationPermissionActivity.Callback callback) {
        if (!needsRuntimePermission() || !"default".equals(state(activity))) {
            callback.done(state(activity));
            return;
        }
        NotificationPermissionActivity.request(activity, (outcome) -> {
            // Refused for now: the row keeps its button and the system asks again.
            callback.done(outcome == VoicePermission.Outcome.GRANTED ? state(activity) : outcome == VoicePermission.Outcome.BLOCKED ? "denied" : "default");
        });
    }

    /* ---------- TaskNotifier.Platform ---------- */

    @Override
    public String get(String key) {
        return preferences.getString(key, null);
    }

    @Override
    public void put(String key, String value) {
        if (value == null) preferences.edit().remove(key).apply();
        else preferences.edit().putString(key, value).apply();
    }

    @Override
    public long elapsed() {
        return SystemClock.elapsedRealtime();
    }

    @Override
    public boolean canNotify() {
        return allowed(context);
    }

    /** The logo's line colour (design/brand), which tints the small icon in the shade. */
    private static final int LINE = 0xFF2463AE;

    /** The logo's lines (android/res/drawable-<density>/ic_stat_morph.png, which scripts/build-android.sh
     *  links in after compiling this, so there is no R class to name it by); Android's chat icon without them. */
    private int smallIcon() {
        int id = context.getResources().getIdentifier("ic_stat_morph", "drawable", context.getPackageName());
        return id != 0 ? id : android.R.drawable.stat_notify_chat;
    }

    @Override
    public void post(String tag, String title, String body, String topicID) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        String name = get(TaskNotifier.TEXT_CHANNEL);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, name == null || name.isEmpty() ? "Topic task notifications" : name,
            NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(context, NotificationOpenActivity.class)
            .putExtra(NotificationOpenActivity.TOPIC, topicID)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        PendingIntent pressed = PendingIntent.getActivity(context, tag.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(smallIcon())
            .setColor(LINE)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pressed)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .build();
        manager.notify(tag, 1, notification);
    }

    @Override
    public void schedule(long delayMs) {
        schedule(context, delayMs);
    }

    static void schedule(Context context, long delayMs) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        if (delayMs < 0) {
            scheduler.cancel(JOB_ID);
            return;
        }
        JobInfo.Builder job = new JobInfo.Builder(JOB_ID, new ComponentName(context, TaskNotifierJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY);
        if (delayMs > 0) job.setMinimumLatency(delayMs);
        try {
            scheduler.schedule(job.build());
        } catch (RuntimeException e) {
            // Too many jobs, or a manifest without the service or ACCESS_NETWORK_STATE (which the network
            // constraint needs on Android 14+): no watch, and nothing else breaks.
        }
    }
}
