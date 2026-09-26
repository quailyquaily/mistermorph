import "./AppSkeleton.css";

// Row widths repeat in this order, so placeholders look like text without being random.
const WIDTHS = [72, 54, 86, 63, 45, 78, 58, 90];

// Placeholder rows for a first load: faint bars that pulse slowly until the real rows arrive.
const AppSkeleton = {
  props: {
    rows: { type: Number, default: 6 },
    label: { type: String, default: "" },
  },
  setup(props) {
    const widths = () => Array.from({ length: Math.max(1, props.rows) }, (_, index) => WIDTHS[index % WIDTHS.length]);
    return { widths };
  },
  template: `
    <div class="app-skeleton" role="status" :aria-label="label || undefined">
      <span v-for="(width, index) in widths()" :key="index" class="app-skeleton-row">
        <span class="app-skeleton-lead"></span>
        <span class="app-skeleton-bar" :style="{ width: width + '%', animationDelay: index * 90 + 'ms' }"></span>
      </span>
    </div>
  `,
};

export default AppSkeleton;
