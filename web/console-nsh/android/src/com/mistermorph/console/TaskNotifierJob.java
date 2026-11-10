package com.mistermorph.console;

import android.app.job.JobParameters;
import android.app.job.JobService;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The job {@link TaskNotifier} watches from while the app is away: Android runs it when there is a
 * network, also after it ended the app's process, and stops it after about ten minutes, so each one
 * asks for {@link TaskNotifier#JOB_BUDGET_MS} at most and schedules the next.
 */
public final class TaskNotifierJob extends JobService {
    /** One run of the job: stopping it is this run's alone (a new run may already have started). */
    private static final class Run {
        volatile boolean stopped;
    }

    private final Map<JobParameters, Run> runs = new ConcurrentHashMap<>();

    @Override
    public boolean onStartJob(JobParameters params) {
        TaskNotifier notifier = AndroidTaskNotifications.notifier(this);
        Run run = new Run();
        runs.put(params, run);
        new Thread(() -> {
            long next = notifier.work(TaskNotifier.JOB_BUDGET_MS, () -> !run.stopped);
            runs.remove(params);
            if (run.stopped) return;
            jobFinished(params, false);
            if (next >= 0 && !notifier.isForeground()) AndroidTaskNotifications.schedule(this, next);
        }, "morph-task-notifier").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Stopped by Android (the network went away, or the time is up) or cancelled by the app.
        Run run = runs.remove(params);
        if (run != null) run.stopped = true;
        AndroidTaskNotifications.notifier(this).abort();
        // Android runs it again later unless the app cancelled it; a cancelled job is not rescheduled.
        return true;
    }
}
