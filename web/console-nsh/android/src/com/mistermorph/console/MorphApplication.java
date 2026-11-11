package com.mistermorph.console;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The phone app's own native part: `nsh package` builds the app around nsh's AppActivity, which is
 * final, so this Application (named in the manifest by scripts/build-android.sh) finds the activity's
 * NshView and answers the console's `morph.voice.*` host calls on it with a {@link VoiceController}.
 * The activity's start and stop are the controller's foreground: leaving the app ends a recording.
 *
 * <p>It also answers `morph.notify.*`: the notification permission, the settings of the
 * {@link TaskNotifier} that tells of finished tasks while the app is away (which the activity's
 * stop starts and its start ends) and the topic of a pressed notification.
 */
public final class MorphApplication extends Application implements Application.ActivityLifecycleCallbacks {
    private final Map<Activity, Attached> attached = new WeakHashMap<>();
    private TaskNotifier notifier;

    private static final class Attached {
        final VoiceController voice;
        final ExecutorService executor;
        final NshView view;

        Attached(VoiceController voice, ExecutorService executor, NshView view) {
            this.voice = voice;
            this.executor = executor;
            this.view = view;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        AndroidVoicePlatform.clearLeftovers(this);
        notifier = AndroidTaskNotifications.notifier(this);
        registerActivityLifecycleCallbacks(this);
    }

    private static NshView findView(View view) {
        if (view instanceof NshView) return (NshView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                NshView found = findView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    /** Answers `morph.voice.*` on the activity's NshView, once it has one (AppActivity makes it in onCreate). */
    private Attached attach(Activity activity) {
        Attached existing = attached.get(activity);
        if (existing != null || ours(activity) || activity.getWindow() == null) return existing;
        NshView view = findView(activity.getWindow().getDecorView());
        if (view == null) return null;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        VoiceController voice = new VoiceController(new AndroidVoicePlatform(activity, view, executor));
        view.handle("morph.voice.support", (data, reply) -> reply.resolve(voice.support()));
        view.handle("morph.voice.start", (data, reply) -> voice.start(answer(reply)));
        view.handle("morph.voice.stop", (data, reply) -> voice.stop(answer(reply)));
        view.handle("morph.voice.cancel", (data, reply) -> {
            voice.cancel();
            reply.resolve(null);
        });
        view.handle("morph.voice.upload", (data, reply) -> voice.upload(data instanceof Map ? (Map<?, ?>) data : new java.util.HashMap<>(), answer(reply)));
        view.handle("morph.voice.release", (data, reply) -> {
            voice.release(data instanceof Map ? MultipartUpload.text(((Map<?, ?>) data).get("id")) : "");
            reply.resolve(null);
        });
        view.handle("morph.notify.state", (data, reply) -> reply.resolve(AndroidTaskNotifications.state(activity)));
        view.handle("morph.notify.request", (data, reply) -> AndroidTaskNotifications.request(activity, reply::resolve));
        view.handle("morph.notify.configure", (data, reply) -> {
            notifier.configure(data instanceof Map ? (Map<?, ?>) data : new java.util.HashMap<>());
            reply.resolve(null);
        });
        view.handle("morph.notify.take", (data, reply) -> {
            String topicID = notifier.takeOpened();
            if (topicID.isEmpty()) {
                reply.resolve(null);
                return;
            }
            Map<String, Object> opened = new java.util.HashMap<>();
            opened.put("topic_id", topicID);
            reply.resolve(opened);
        });
        Attached result = new Attached(voice, executor, view);
        attached.put(activity, result);
        return result;
    }

    /** The app's own activities over nsh's: asking for a permission, opening a notification. */
    private static boolean ours(Activity activity) {
        return activity instanceof VoicePermissionActivity || activity instanceof NotificationPermissionActivity
            || activity instanceof NotificationOpenActivity;
    }

    private static VoiceController.Reply answer(NshHostReply reply) {
        return new VoiceController.Reply() {
            @Override
            public void resolve(Object value) {
                reply.resolve(value);
            }

            @Override
            public void reject(String message) {
                reply.reject(message);
            }
        };
    }

    // The app asks `morph.voice.support` once at boot (lib/mobileHost.ts), after reading its saved
    // values, to know whether it can record: the handlers must be there by then. AppActivity's
    // onCreate makes the view and starts loading the app last; the handlers are registered right
    // after it, in the same turn of the UI thread.
    @Override
    public void onActivityPostCreated(Activity activity, Bundle state) {
        // Android 10 and newer: right after onCreate.
        attach(activity);
    }

    @Override
    public void onActivityStarted(Activity activity) {
        // Android 9 has no onActivityPostCreated: onStart runs in the same launch transaction.
        Attached current = attach(activity);
        if (current != null) current.voice.foreground();
        if (ours(activity)) return;
        notifier.foreground();
        // A pressed notification brought the app back: the app takes its topic (on a cold start it
        // asks at boot instead, before it listens).
        if (current != null && notifier.hasOpened()) current.view.send("morph.notify.opened", new java.util.HashMap<String, Object>());
    }

    @Override
    public void onActivityStopped(Activity activity) {
        Attached current = attached.get(activity);
        if (current != null) current.voice.background();
        // Rotations do not stop the activity (it handles them itself), so this is leaving the app.
        if (!ours(activity) && !activity.isChangingConfigurations()) notifier.background();
    }

    @Override
    public void onActivityDestroyed(Activity activity) {
        Attached current = attached.remove(activity);
        if (current == null) return;
        current.voice.close();
        current.executor.shutdown();
    }

    @Override
    public void onActivityCreated(Activity activity, Bundle state) {}

    @Override
    public void onActivityResumed(Activity activity) {}

    @Override
    public void onActivityPaused(Activity activity) {}

    @Override
    public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
}
