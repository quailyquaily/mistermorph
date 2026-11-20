package com.mistermorph.console;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Runs on the JDK alone (scripts/android-host.sh test): what `morph.keyboard.state` answers. */
public final class HardwareKeyboardTest {
    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    // virtual, enabled, keyboard source, alphabetic
    private static final HardwareKeyboard.Device BLUETOOTH = new HardwareKeyboard.Device(false, true, true, true);
    private static final HardwareKeyboard.Device VIRTUAL = new HardwareKeyboard.Device(true, true, true, true);
    private static final HardwareKeyboard.Device BUTTONS = new HardwareKeyboard.Device(false, true, true, false);
    private static final HardwareKeyboard.Device TOUCHSCREEN = new HardwareKeyboard.Device(false, true, false, false);
    private static final HardwareKeyboard.Device DISABLED = new HardwareKeyboard.Device(false, false, true, true);
    private static final HardwareKeyboard.Device MOUSE_SAYING_ALPHABETIC = new HardwareKeyboard.Device(false, true, false, true);

    private static String state(boolean hidden, HardwareKeyboard.Device... devices) {
        return HardwareKeyboard.state(Arrays.asList(devices), hidden);
    }

    public static void main(String[] args) {
        check("connected".equals(state(false, VIRTUAL, BUTTONS, TOUCHSCREEN, BLUETOOTH)), "a real alphabetic keyboard among the phone's own devices");
        check("connected".equals(state(false, BLUETOOTH)), "a keyboard alone");

        // A phone as it is: the virtual keyboard (the software keyboard's keys), its buttons, its screen.
        check("disconnected".equals(state(false, VIRTUAL, BUTTONS, TOUCHSCREEN)), "a phone's own devices are no keyboard");
        check("disconnected".equals(state(false)), "no devices");
        check("disconnected".equals(state(false, VIRTUAL)), "the virtual keyboard is not hardware");
        check("disconnected".equals(state(false, BUTTONS)), "volume and power buttons are not a keyboard to type on");
        check("disconnected".equals(state(false, DISABLED)), "a disabled keyboard");
        check("disconnected".equals(state(false, MOUSE_SAYING_ALPHABETIC)), "not a keyboard source");
        check("disconnected".equals(state(false, (HardwareKeyboard.Device) null)), "a device that went away while listing");

        // A slider closed, a cover folded back: the keyboard is there but cannot be typed on.
        check("disconnected".equals(state(true, BLUETOOTH)), "a hidden hardware keyboard");

        // Android could not be asked: never "connected", and not "disconnected" either.
        check("unknown".equals(HardwareKeyboard.state(null, false)), "no device list is unknown");
        check("unknown".equals(HardwareKeyboard.state(null, true)), "no device list is unknown, hidden or not");

        check("connected".equals(HardwareKeyboard.describe("connected").get("physical")), "the answer's shape");
        check("disconnected".equals(HardwareKeyboard.describe("disconnected").get("physical")), "the answer's shape");
        check("unknown".equals(HardwareKeyboard.describe("unknown").get("physical")), "the answer's shape");
        check("unknown".equals(HardwareKeyboard.describe(null).get("physical")), "nothing is unknown");
        check("unknown".equals(HardwareKeyboard.describe("yes").get("physical")), "anything else is unknown");
        check(HardwareKeyboard.describe("connected").size() == 1, "only `physical`");

        List<HardwareKeyboard.Device> many = new ArrayList<>(Collections.nCopies(20, BUTTONS));
        many.add(BLUETOOTH);
        check("connected".equals(HardwareKeyboard.state(many, false)), "the keyboard anywhere in the list");
        System.out.println("HardwareKeyboardTest: ok");
    }
}
