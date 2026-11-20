package com.mistermorph.console;

import android.content.Context;
import android.content.res.Configuration;
import android.hardware.input.InputManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.InputDevice;
import com.longbridge.nsh.NshView;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@link HardwareKeyboard} on Android: reads the input devices from the system's InputManager and
 * the hardware keyboard's hidden flag from the configuration, answers `morph.keyboard.state`, and
 * tells the console (`morph.keyboard.changed`) when the state changes: a device added, removed or
 * changed (InputManager's listener, on the UI thread), a configuration change (MorphApplication)
 * or the activity coming back to the front. Without an InputManager, or when it throws, the state
 * is "unknown".
 */
final class AndroidHardwareKeyboard implements InputManager.InputDeviceListener {
    private final Context context;
    private final NshView view;
    private final InputManager manager;
    // What the console knows: the last answer or event. Null before it asked.
    private String told;

    AndroidHardwareKeyboard(Context context, NshView view) {
        this.context = context.getApplicationContext();
        this.view = view;
        InputManager found = null;
        try {
            found = (InputManager) this.context.getSystemService(Context.INPUT_SERVICE);
            if (found != null) found.registerInputDeviceListener(this, new Handler(Looper.getMainLooper()));
        } catch (RuntimeException error) {
            found = null;
        }
        manager = found;
    }

    private String read(Configuration configuration) {
        if (manager == null) return HardwareKeyboard.UNKNOWN;
        try {
            List<HardwareKeyboard.Device> devices = new ArrayList<>();
            for (int id : manager.getInputDeviceIds()) {
                InputDevice device = manager.getInputDevice(id);
                // Gone between the two calls.
                if (device == null) continue;
                devices.add(new HardwareKeyboard.Device(
                    device.isVirtual(),
                    Build.VERSION.SDK_INT < 27 || device.isEnabled(),
                    (device.getSources() & InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD,
                    device.getKeyboardType() == InputDevice.KEYBOARD_TYPE_ALPHABETIC));
            }
            Configuration current = configuration != null ? configuration : context.getResources().getConfiguration();
            return HardwareKeyboard.state(devices, current.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_YES);
        } catch (RuntimeException error) {
            return HardwareKeyboard.UNKNOWN;
        }
    }

    /** The answer to `morph.keyboard.state`. */
    Map<String, Object> answer() {
        told = read(null);
        return HardwareKeyboard.describe(told);
    }

    /** Reads the state again and tells the console when it is not what it was told; `configuration` is the new one, or null for the current. */
    void refresh(Configuration configuration) {
        String next = read(configuration);
        if (next.equals(told)) return;
        told = next;
        view.send("morph.keyboard.changed", HardwareKeyboard.describe(next));
    }

    void close() {
        if (manager == null) return;
        try {
            manager.unregisterInputDeviceListener(this);
        } catch (RuntimeException error) {
            // Already gone with the activity.
        }
    }

    @Override
    public void onInputDeviceAdded(int deviceId) {
        refresh(null);
    }

    @Override
    public void onInputDeviceRemoved(int deviceId) {
        refresh(null);
    }

    @Override
    public void onInputDeviceChanged(int deviceId) {
        refresh(null);
    }
}
