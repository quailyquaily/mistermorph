package com.mistermorph.console;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;

/**
 * Asks where to save a file: the system's picker for a new document ({@code ACTION_CREATE_DOCUMENT},
 * the Storage Access Framework, which needs no storage permission). nsh's AppActivity is final and
 * hears no activity results, so this transparent activity shows the picker over it and reports the
 * chosen document (or the user backing out) to the one request waiting.
 */
public final class SaveDocumentActivity extends Activity {
    private static final int REQUEST = 1;
    private static final String NAME = "name";
    private static final String MIME = "mime";
    private static final String SHOWN = "shown";

    // The request waiting for an answer; UI thread only.
    private static FileSaver.DestinationCallback pending;

    // The request this activity answers: a newer one is not this one's to answer.
    private FileSaver.DestinationCallback callback;

    /** The picker's intent for a new document named {@code name} of type {@code mime}. */
    static Intent createDocument(String name, String mime) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        return intent;
    }

    static void request(Activity from, String name, String mime, FileSaver.DestinationCallback callback) {
        // One question at a time: an older one that never came back is cancelled.
        deliverCancelled();
        pending = callback;
        Intent intent = new Intent(from, SaveDocumentActivity.class);
        intent.putExtra(NAME, name);
        intent.putExtra(MIME, mime);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        try {
            from.startActivity(intent);
        } catch (RuntimeException e) {
            FileSaver.DestinationCallback waiting = pending;
            pending = null;
            if (waiting != null) waiting.failed("The save dialog could not be opened.");
        }
    }

    private static void deliverCancelled() {
        FileSaver.DestinationCallback waiting = pending;
        pending = null;
        if (waiting != null) waiting.cancelled();
    }

    /** Hands the answer to this activity's request, if it is still the one waiting. */
    private FileSaver.DestinationCallback take() {
        FileSaver.DestinationCallback mine = callback;
        callback = null;
        if (mine == null || pending != mine) return null;
        pending = null;
        return mine;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        callback = pending;
        // Recreated while the picker is up: the picker answers this activity again (and, when the
        // process was restarted under it, a document it makes is nobody's: onActivityResult deletes it).
        if (state != null && state.getBoolean(SHOWN)) return;
        if (callback == null) {
            // Nothing waits: nothing to ask.
            finish();
            return;
        }
        Intent intent = getIntent();
        try {
            startActivityForResult(createDocument(intent.getStringExtra(NAME), intent.getStringExtra(MIME)), REQUEST);
        } catch (ActivityNotFoundException e) {
            FileSaver.DestinationCallback mine = take();
            if (mine != null) mine.failed("No app on this device can save files.");
            finish();
            overridePendingTransition(0, 0);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean(SHOWN, true);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST) return;
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        FileSaver.DestinationCallback mine = take();
        if (mine != null) {
            if (uri != null) mine.picked(uri);
            else mine.cancelled();
        } else if (uri != null) {
            // The save that asked is gone (the process was restarted): leave no empty document.
            try {
                DocumentsContract.deleteDocument(getContentResolver(), uri);
            } catch (Exception e) {
                // Not deletable here: it stays empty.
            }
        }
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        // Gone without an answer (closed by the system): nothing was chosen.
        if (isFinishing()) {
            FileSaver.DestinationCallback mine = take();
            if (mine != null) mine.cancelled();
        }
        super.onDestroy();
    }
}
