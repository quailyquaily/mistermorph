package com.mistermorph.console;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Whether a hardware keyboard is connected, the answer to the console's `morph.keyboard.state`
 * host call and the data of its `morph.keyboard.changed` event (lib/mobileHost.ts): the console's
 * keyboard shortcuts are on in the phone app only while this says "connected"
 * (lib/shortcutPolicy.ts).
 *
 * <p>A keyboard counts when Android lists an input device that is a real one (not virtual: the
 * software keyboard and injected keys come from the virtual keyboard), is enabled, is a keyboard
 * source and has a full alphabetic layout (a phone's volume and power buttons are a keyboard source
 * too, but not an alphabetic one), built in (a Chromebook's, a slider's) or attached (USB,
 * Bluetooth, a tablet's cover); and when the configuration does not say the hardware keyboard is
 * hidden (a closed slider, a cover folded back). Nothing else is taken for one: not a key event,
 * not the software keyboard being hidden. When Android cannot be asked the state is "unknown",
 * which the console treats as no keyboard.
 *
 * <p>This class is the decision alone, without Android (scripts/android-host.sh test);
 * {@link AndroidHardwareKeyboard} reads the devices and watches them.
 */
final class HardwareKeyboard {
    static final String CONNECTED = "connected";
    static final String DISCONNECTED = "disconnected";
    static final String UNKNOWN = "unknown";

    private HardwareKeyboard() {}

    /** What Android says of one input device. */
    static final class Device {
        final boolean virtual;
        final boolean enabled;
        final boolean keyboardSource;
        final boolean alphabetic;

        Device(boolean virtual, boolean enabled, boolean keyboardSource, boolean alphabetic) {
            this.virtual = virtual;
            this.enabled = enabled;
            this.keyboardSource = keyboardSource;
            this.alphabetic = alphabetic;
        }

        boolean physicalKeyboard() {
            return !virtual && enabled && keyboardSource && alphabetic;
        }
    }

    /**
     * The state from the input devices Android lists (`null` when it could not be asked) and
     * whether the configuration says the hardware keyboard is hidden.
     */
    static String state(List<Device> devices, boolean hidden) {
        if (devices == null) return UNKNOWN;
        if (hidden) return DISCONNECTED;
        for (Device device : devices) {
            if (device != null && device.physicalKeyboard()) return CONNECTED;
        }
        return DISCONNECTED;
    }

    /** `{physical}`: what the console is answered and told. */
    static Map<String, Object> describe(String state) {
        Map<String, Object> answer = new HashMap<>();
        answer.put("physical", CONNECTED.equals(state) || DISCONNECTED.equals(state) ? state : UNKNOWN);
        return answer;
    }
}
