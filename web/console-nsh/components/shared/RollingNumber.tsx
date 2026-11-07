// RollingNumber shows a formatted number ("$53.58", "8,404", "601.73M") whose digits roll to their
// new value, each on its own wheel, instead of jumping (the Vue console's RollingNumber).
//
// A wheel turns the short way round, like a counter's: 9 to 0 is one step on, 2 to 8 four steps
// back. Its strip holds the digits three times; the wheel steps from where it stands and, once it
// settles, re-centres on the middle run without motion, so it never runs out. Digits keep their
// wheel from the right, so 999 becomes 1,000 by turning the three and adding the one. Figures are
// tabular, so wheels never change width as they turn. Reduced motion makes them jump.
//
// The text style (size, weight, color) comes from `class`, applied to every glyph. Screen readers
// and tests get the plain value.
import { batch, cleanup, computed, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import { wheelStep } from "../../lib/core/rolling-wheel.js";

const RUNS = 3;
const MIDDLE = 10;
const STRIP = Array.from({ length: RUNS * 10 }, (_, i) => ({ i, n: i % 10 }));
const TURN_MS = 420;

interface Glyph {
  key: string;
  ch: string;
  digit: number;
}

export interface RollingNumberProps {
  /** The formatted value; its digits roll, everything else is shown as it is. */
  value?: string | number;
  /** Text classes for the glyphs (size, weight, color, font). */
  class?: string;
  testID?: string;
}

export function RollingNumber(props: RollingNumberProps) {
  const text = computed(() => String(props.value ?? ""));
  const glyphs = computed<Glyph[]>(() => {
    const chars = [...text()];
    return chars.map((ch, index) => {
      const isDigit = /\d/.test(ch);
      return { key: `${chars.length - index}:${isDigit ? "d" : ch}`, ch, digit: isDigit ? Number(ch) : -1 };
    });
  });

  // Where each wheel stands on its strip (0 to 29), and which are re-centring without motion.
  // Kept by glyph key, outside the rows, as data.
  let stops: Record<string, number> = {};
  const stopsSignal = signal<Record<string, number>>({});
  const still = signal<Record<string, boolean>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  cleanup(() => timers.forEach((id) => clearTimeout(id)));

  const settle = (key: string) => {
    timers.delete(key);
    const at = stops[key];
    if (at === undefined || (at >= MIDDLE && at < MIDDLE + 10)) return;
    stops = { ...stops, [key]: MIDDLE + (at % 10) };
    batch(() => {
      still.update((s) => ({ ...s, [key]: true }));
      stopsSignal.set(stops);
    });
    setTimeout(() => still.update((s) => ({ ...s, [key]: false })), 32);
  };

  // Steps every wheel to its new digit when the value changes.
  effect(() => {
    const next = glyphs();
    untracked(() => {
      const updated = { ...stops };
      for (const glyph of next) {
        if (glyph.digit < 0) continue;
        const at = updated[glyph.key];
        if (at === undefined) {
          updated[glyph.key] = MIDDLE + glyph.digit;
          continue;
        }
        const step = wheelStep(at, glyph.digit);
        if (step === 0) continue;
        updated[glyph.key] = at + step;
        const key = glyph.key;
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => settle(key), reduceMotion() ? 0 : TURN_MS + 20));
      }
      stops = updated;
      stopsSignal.set(updated);
    });
  });
  const stopOf = (key: string) => stopsSignal()[key] ?? MIDDLE;

  // The height of one digit, measured from the ghost of the first wheel; until then the ghosts show.
  const digitHeight = signal(0);

  return (
    <View class="relative flex-row" accessibilityLabel={text()} testID={props.testID}>
      <Text class={`absolute opacity-0 tabular-nums ${props.class ?? ""}`} style={{ numberOfLines: 1 }}>
        {text()}
      </Text>
      <Each of={glyphs()} key={(glyph) => glyph.key}>
        {(glyph) => (
          <If
            when={glyph().digit >= 0}
            else={
              <Text class={`tabular-nums ${props.class ?? ""}`} accessibilityElementsHidden>
                {glyph().ch}
              </Text>
            }
          >
            <View class="relative overflow-hidden" accessibilityElementsHidden>
              <Text
                class={`tabular-nums ${props.class ?? ""}`}
                style={{ opacity: digitHeight() > 0 ? 0 : 1 }}
                onLayout={({ bounds }) => {
                  if (bounds.size.height > 0 && Math.abs(bounds.size.height - untracked(digitHeight)) > 0.5) digitHeight.set(bounds.size.height);
                }}
              >
                {String(glyph().digit)}
              </Text>
              <View
                class="absolute left-0 right-0 top-0"
                style={{
                  opacity: digitHeight() > 0 ? 1 : 0,
                  transform: [{ translateY: -stopOf(glyph().key) * digitHeight() }],
                  transitionProperty: "transform",
                  transitionDuration: still()[glyph().key] || reduceMotion() ? 0 : TURN_MS,
                  transitionTimingFunction: "cubic-bezier(0.2, 0.7, 0.1, 1)",
                }}
              >
                <Each of={STRIP} key={(cell) => cell.i}>
                  {(cell) => (
                    <Text class={`text-center tabular-nums ${props.class ?? ""}`} style={{ height: digitHeight() || undefined }}>
                      {String(cell().n)}
                    </Text>
                  )}
                </Each>
              </View>
            </View>
          </If>
        )}
      </Each>
    </View>
  );
}
