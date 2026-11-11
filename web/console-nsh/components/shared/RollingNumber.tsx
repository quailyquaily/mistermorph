// RollingNumber shows a formatted number ("$53.58", "8,404", "601.73M") whose digits roll to their
// new value, each on its own wheel, instead of jumping (the Vue console's RollingNumber).
//
// A wheel turns the short way round, like a counter's: 9 to 0 is one step on, 2 to 8 four steps
// back. At rest a wheel is just its digit. Only while it turns does it hold a strip, of the digits
// it passes (six at most), moving from the old one to the new: a page shows dozens of these
// numbers, and a strip of every digit kept under each wheel made thousands of text views that
// were laid out on every change (the usage page's hosts: 22,000 views, 150ms a commit). Digits
// keep their wheel from the right, so 999 becomes 1,000 by turning the three and adding the one.
// Figures are tabular, so wheels never change width as they turn. Reduced motion makes them jump.
//
// The text style (size, weight, color) comes from `class`, applied to every glyph. Screen readers
// and tests get the plain value.
import { cleanup, computed, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import { wheelStep } from "../../lib/core/rolling-wheel.js";

// Vue's --motion-slow, with its cubic-bezier(0.2, 0.7, 0.1, 1).
const TURN_MS = 260;

interface Glyph {
  key: string;
  ch: string;
  digit: number;
}

/** A wheel turning: the strip holds the digits at positions `lo` to `hi` (position p shows p mod
 * 10), and moves from `from` to `to`; `running` is false for the first frame, which places the
 * strip at `from` without motion. */
interface Turn {
  lo: number;
  hi: number;
  from: number;
  to: number;
  running: boolean;
}

const digitAt = (position: number) => ((position % 10) + 10) % 10;

export interface RollingNumberProps {
  /** The formatted value; its digits roll, everything else is shown as it is. */
  value?: string | number;
  /** Text classes for the glyphs (size, weight, color, font). */
  class?: string;
  /** Text style for the glyphs, for what a class cannot say (a computed font size). */
  style?: Record<string, unknown>;
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

  // The digit each wheel last showed, by glyph key (data, outside the rows), and the wheels
  // turning now.
  let shown: Record<string, number> = {};
  const turns = signal<Record<string, Turn>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  cleanup(() => timers.forEach((id) => clearTimeout(id)));
  const later = (key: string, ms: number, run: () => void) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run();
      }, ms),
    );
  };
  const endTurn = (key: string) =>
    turns.update((all) => {
      const { [key]: _done, ...rest } = all;
      return rest;
    });

  // The height of one digit, measured from a wheel's digit; no turning until it is known.
  const digitHeight = signal(0);

  // Turns every wheel whose digit changed. A wheel turning already starts again from the digit it
  // was turning to.
  effect(() => {
    const next = glyphs();
    untracked(() => {
      const started: Record<string, Turn> = {};
      const animate = !reduceMotion() && digitHeight() > 0;
      for (const glyph of next) {
        if (glyph.digit < 0) continue;
        const from = shown[glyph.key];
        shown[glyph.key] = glyph.digit;
        if (from === undefined || from === glyph.digit || !animate) continue;
        const to = from + wheelStep(from, glyph.digit);
        started[glyph.key] = { lo: Math.min(from, to), hi: Math.max(from, to), from, to, running: false };
      }
      const keys = Object.keys(started);
      if (keys.length === 0) return;
      turns.update((all) => ({ ...all, ...started }));
      for (const key of keys) {
        // The strip is placed at the old digit for a frame, then moves; once it has stopped the
        // wheel is its digit again.
        later(key, 32, () => {
          turns.update((all) => (all[key] ? { ...all, [key]: { ...all[key], running: true } } : all));
          later(key, TURN_MS + 20, () => endTurn(key));
        });
      }
    });
  });

  return (
    <View class="relative flex-row" accessibilityLabel={text()} testID={props.testID}>
      <Text class={`absolute opacity-0 tabular-nums ${props.class ?? ""}`} style={{ ...props.style, numberOfLines: 1 }}>
        {text()}
      </Text>
      <Each of={glyphs()} key={(glyph) => glyph.key}>
        {(glyph) => (
          <If
            when={glyph().digit >= 0}
            else={
              <Text class={`tabular-nums ${props.class ?? ""}`} style={props.style} accessibilityElementsHidden>
                {glyph().ch}
              </Text>
            }
          >
            <View class="relative overflow-hidden" accessibilityElementsHidden>
              {/* The digit: the wheel at rest, and its box (and the height of a strip's cell) while
                  the strip turns over it. */}
              <Text
                class={`tabular-nums ${props.class ?? ""}`}
                style={{ ...props.style, opacity: turns()[glyph().key] ? 0 : 1 }}
                onLayout={({ bounds }) => {
                  if (bounds.size.height > 0 && Math.abs(bounds.size.height - untracked(digitHeight)) > 0.5) digitHeight.set(bounds.size.height);
                }}
              >
                {String(glyph().digit)}
              </Text>
              <If when={turns()[glyph().key]}>
                {(turn) => (
                  <View
                    class="absolute left-0 right-0 top-0"
                    style={{
                      transform: [{ translateY: -((turn().running ? turn().to : turn().from) - turn().lo) * digitHeight() }],
                      transitionProperty: "transform",
                      transitionDuration: turn().running ? TURN_MS : 0,
                      transitionTimingFunction: "cubic-bezier(0.2, 0.7, 0.1, 1)",
                    }}
                  >
                    <Each of={Array.from({ length: turn().hi - turn().lo + 1 }, (_, i) => turn().lo + i)}>
                      {(position) => (
                        <Text class={`text-center tabular-nums ${props.class ?? ""}`} style={{ ...props.style, height: digitHeight() }}>
                          {String(digitAt(position()))}
                        </Text>
                      )}
                    </Each>
                  </View>
                )}
              </If>
            </View>
          </If>
        )}
      </Each>
    </View>
  );
}
