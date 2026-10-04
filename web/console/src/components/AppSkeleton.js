import "./AppSkeleton.css";

// Row widths repeat in this order, so placeholders look like text without being random.
const WIDTHS = [72, 54, 86, 63, 45, 78, 58, 90];

// How many text bars a card of this height holds under its title bar.
function cardLines(height) {
  const px = Number.parseFloat(String(height || ""));
  if (!Number.isFinite(px)) return 1;
  return Math.max(0, Math.min(6, Math.floor((px - 34) / 18)));
}

// Placeholders for a first load: faint bars that pulse slowly until the real content arrives.
// variant "rows" (the default) is a list of table rows; "card" is count hairline-bordered cards
// of the given height, each a title bar over a few text bars.
const AppSkeleton = {
  props: {
    rows: { type: Number, default: 6 },
    label: { type: String, default: "" },
    variant: { type: String, default: "rows" },
    count: { type: Number, default: 1 },
    height: { type: String, default: "" },
  },
  setup(props) {
    const widths = () => Array.from({ length: Math.max(1, props.rows) }, (_, index) => WIDTHS[index % WIDTHS.length]);
    const cards = () =>
      Array.from({ length: Math.max(1, props.count) }, (_, card) => ({
        title: [38, 46, 32, 42][card % 4],
        lines: Array.from({ length: cardLines(props.height) }, (_, line) => WIDTHS[(card * 3 + line) % WIDTHS.length]),
      }));
    return { widths, cards };
  },
  template: `
    <div v-if="variant === 'card'" class="app-skeleton is-cards" role="status" :aria-label="label || undefined">
      <span v-for="(card, index) in cards()" :key="index" class="app-skeleton-card" :style="height ? { height } : null">
        <span class="app-skeleton-bar is-title" :style="{ width: card.title + '%', animationDelay: index * 90 + 'ms' }"></span>
        <span
          v-for="(width, line) in card.lines"
          :key="line"
          class="app-skeleton-bar"
          :style="{ width: width + '%', animationDelay: index * 90 + (line + 1) * 60 + 'ms' }"
        ></span>
      </span>
    </div>
    <div v-else class="app-skeleton" role="status" :aria-label="label || undefined">
      <span v-for="(width, index) in widths()" :key="index" class="app-skeleton-row">
        <span class="app-skeleton-lead"></span>
        <span class="app-skeleton-bar" :style="{ width: width + '%', animationDelay: index * 90 + 'ms' }"></span>
      </span>
    </div>
  `,
};

export default AppSkeleton;
