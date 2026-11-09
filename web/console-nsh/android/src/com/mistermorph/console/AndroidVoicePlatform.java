package com.mistermorph.console;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import com.longbridge.nsh.NshView;
import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ExecutorService;

/** Android's microphone for {@link VoiceController}: MediaRecorder writing AAC (MPEG-4) into the cache. */
final class AndroidVoicePlatform implements VoicePlatform {
    // Speech: one channel is enough, and 64 kbit/s AAC keeps five minutes under 3 MB.
    private static final int SAMPLE_RATE = 44_100;
    private static final int BIT_RATE = 64_000;

    private final Activity activity;
    private final NshView view;
    private final ExecutorService executor;

    AndroidVoicePlatform(Activity activity, NshView view, ExecutorService executor) {
        this.activity = activity;
        this.view = view;
        this.executor = executor;
    }

    /** Where recordings are kept until they are sent or thrown away. */
    static File directory(android.content.Context context) {
        return new File(context.getCacheDir(), "voice");
    }

    /** Deletes recordings a killed process left behind. */
    static void clearLeftovers(android.content.Context context) {
        File[] leftovers = directory(context).listFiles();
        if (leftovers == null) return;
        for (File file : leftovers) {
            if (!file.delete()) file.deleteOnExit();
        }
    }

    @Override
    public boolean hasMicrophone() {
        return activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MICROPHONE);
    }

    @Override
    public boolean hasPermission() {
        return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void requestPermission(PermissionCallback callback) {
        VoicePermissionActivity.request(activity, callback);
    }

    @Override
    public File createRecordingFile() throws IOException {
        File dir = directory(activity);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        return File.createTempFile("voice-", ".m4a", dir);
    }

    @Override
    public Recording startRecording(File file, RecordingErrorListener onError) throws Exception {
        final MediaRecorder recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(activity) : new MediaRecorder();
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(SAMPLE_RATE);
            recorder.setAudioEncodingBitRate(BIT_RATE);
            recorder.setOutputFile(file.getPath());
            recorder.setOnErrorListener((mr, what, extra) -> onError.failed("The recorder stopped (" + what + ", " + extra + ")."));
            recorder.prepare();
            recorder.start();
        } catch (Exception e) {
            recorder.release();
            throw e;
        }
        return new Recording() {
            @Override
            public boolean stop() {
                try {
                    recorder.stop();
                    return true;
                } catch (RuntimeException e) {
                    // Stopped before any audio was written: MediaRecorder deletes nothing, it throws.
                    return false;
                }
            }

            @Override
            public void release() {
                recorder.release();
            }
        };
    }

    @Override
    public void send(String name, Map<String, Object> data) {
        view.send(name, data);
    }

    @Override
    public void runInBackground(Runnable task) {
        executor.execute(task);
    }
}
