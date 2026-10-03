import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { startMosaicText } from "../core/mosaic-text";
import "./MosaicText.css";

// Resolves a CSS colour (a theme variable, color-mix, anything) to [r, g, b] by painting it: the
// canvas the mosaic draws on takes plain colours only.
function resolveColor(host, value) {
  const probe = document.createElement("span");
  probe.style.color = value;
  host.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!pixel) return null;
  pixel.fillStyle = computed;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

// A word assembling itself from mosaic pieces (core/mosaic-text.js), for a wait. The words are
// for the eye; screen readers get label, or the text.
const MosaicText = {
  name: "MosaicText",
  props: {
    text: { type: String, required: true },
    label: { type: String, default: "" },
    // px from one pixel of a letter to the next; letters are 7 pitches tall.
    pitch: { type: Number, default: 2 },
    ink: { type: String, default: "var(--text-2)" },
    loose: { type: String, default: "var(--line)" },
  },
  setup(props) {
    const root = ref(null);
    const canvas = ref(null);
    let stop = () => {};

    function start() {
      stop();
      if (!root.value || !canvas.value) return;
      stop = startMosaicText(canvas.value, props.text, {
        pitch: props.pitch,
        ink: resolveColor(root.value, props.ink) || undefined,
        loose: resolveColor(root.value, props.loose) || undefined,
      });
    }

    onMounted(start);
    watch(() => [props.text, props.pitch, props.ink, props.loose], start);
    onBeforeUnmount(() => stop());
    return { root, canvas };
  },
  template: `
    <span ref="root" class="mosaic-text" role="status" :aria-label="label || text">
      <canvas ref="canvas" aria-hidden="true"></canvas>
    </span>
  `,
};

export default MosaicText;
