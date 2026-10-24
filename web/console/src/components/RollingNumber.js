import { computed, reactive, watch } from "vue";

import { wheelStep } from "../core/rolling-wheel";
import "./RollingNumber.css";

// RollingNumber shows a formatted number ("$53.58", "8,404", "601.73M") whose digits roll to their
// new value, each on its own wheel, instead of jumping. A wheel turns the short way round, like a
// counter's: 9 to 0 is one step on, 2 to 8 four steps back. Its strip holds the digits three times,
// the wheel steps from where it stands, and once it settles it re-centres on the middle run without
// motion, so it never runs out. Digits keep their wheel from the right, so 999 becomes 1,000 by
// turning the three and adding the one. Wheels move by transform, which the compositor animates;
// reduced motion sets the motion tokens to zero and they jump. Screen readers get the plain value.
const RUNS = 3;
const MIDDLE = 10;


const RollingNumber = {
  props: {
    value: { type: [String, Number], default: "" },
  },
  setup(props) {
    const text = computed(() => String(props.value ?? ""));
    // Each glyph, keyed by its place from the right, so a wheel stays the same element as the
    // number grows or shrinks.
    const glyphs = computed(() => {
      const chars = [...text.value];
      return chars.map((ch, index) => ({
        key: `${chars.length - index}:${/\d/.test(ch) ? "d" : ch}`,
        ch,
        digit: /\d/.test(ch) ? Number(ch) : -1,
      }));
    });
    // Where each wheel stands on its strip (0 to 29), and which are re-centring without motion.
    const stops = reactive({});
    const still = reactive({});
    watch(
      glyphs,
      (next) => {
        for (const glyph of next) {
          if (glyph.digit < 0) {
            continue;
          }
          const at = stops[glyph.key];
          if (at === undefined) {
            stops[glyph.key] = MIDDLE + glyph.digit;
            continue;
          }
          stops[glyph.key] = at + wheelStep(at, glyph.digit);
        }
      },
      { immediate: true },
    );
    function offset(key) {
      return `translateY(${(-(stops[key] ?? MIDDLE) * 100) / (RUNS * 10)}%)`;
    }
    function settle(key) {
      const at = stops[key];
      if (at === undefined || (at >= MIDDLE && at < MIDDLE + 10)) {
        return;
      }
      still[key] = true;
      stops[key] = MIDDLE + (at % 10);
      requestAnimationFrame(() => requestAnimationFrame(() => delete still[key]));
    }
    return { glyphs, offset, settle, still, text, strip: RUNS * 10 };
  },
  template: `
    <span class="rolling-number">
      <span class="rolling-number-text">{{ text }}</span>
      <span class="rolling-number-glyphs" aria-hidden="true">
        <template v-for="glyph in glyphs" :key="glyph.key">
          <span v-if="glyph.digit >= 0" class="rolling-digit">
            <span class="rolling-digit-ghost">{{ glyph.digit }}</span>
            <span
              :class="['rolling-digit-strip', { 'is-still': still[glyph.key] }]"
              :style="{ transform: offset(glyph.key) }"
              @transitionend.self="settle(glyph.key)"
            >
              <span v-for="n in strip" :key="n">{{ (n - 1) % 10 }}</span>
            </span>
          </span>
          <span v-else class="rolling-char">{{ glyph.ch }}</span>
        </template>
      </span>
    </span>
  `,
};

export default RollingNumber;
