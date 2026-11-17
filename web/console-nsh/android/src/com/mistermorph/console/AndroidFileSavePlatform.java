package com.mistermorph.console;

import android.app.Activity;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;
import android.webkit.MimeTypeMap;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;

/** Android's part of {@link FileSaver}: the picker for a new document and the ContentResolver. */
final class AndroidFileSavePlatform implements FileSaver.Platform {
    private static final String TAG = "MorphFileSave";

    private final Activity activity;
    private final ExecutorService executor;

    AndroidFileSavePlatform(Activity activity, ExecutorService executor) {
        this.activity = activity;
        this.executor = executor;
    }

    @Override
    public boolean canPickDestination() {
        // The manifest's <queries> makes the system's document picker visible to this check.
        return SaveDocumentActivity.createDocument(FileSaver.DEFAULT_NAME, FileSaver.BINARY)
                .resolveActivity(activity.getPackageManager()) != null;
    }

    @Override
    public void pickDestination(String name, String mime, FileSaver.DestinationCallback callback) {
        SaveDocumentActivity.request(activity, name, mime, callback);
    }

    @Override
    public OutputStream open(Object destination) throws IOException {
        // "w" on a new, empty document: some providers do not take "wt".
        OutputStream out = activity.getContentResolver().openOutputStream((Uri) destination, "w");
        if (out == null) throw new FileNotFoundException("the provider gave no stream");
        return out;
    }

    @Override
    public void discard(Object destination) {
        try {
            DocumentsContract.deleteDocument(activity.getContentResolver(), (Uri) destination);
        } catch (Exception e) {
            // Not deletable here: the partial document stays, which the failed save says.
            Log.w(TAG, "could not delete a failed save's document: " + e);
        }
    }

    @Override
    public String mimeForExtension(String extension) {
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
    }

    @Override
    public void runInBackground(Runnable task) {
        executor.execute(task);
    }
}
