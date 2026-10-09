import { computed, onMounted, onUpdated, ref } from "vue";

import "./AppSection.css";

const VARIANTS = new Set(["plain", "boxed", "pane"]);

// A titled block of a page, in the console's own terms, in place of Quail's QCard. The head reads
// like an AppNotice: a square mark and a mono bracket label, then the meta, actions at the far end,
// all on a hairline rule, one fixed-height row. The body is the default slot. The actions slot is
// the head's right end, for plain buttons ("plain xs") and plain dropdown menus (variant="plain")
// only; anything else (filled or outlined buttons, tabs, filters) goes in the body. The lead slot,
// before the mark, holds one plain back button for a pane that replaces its list on a phone. In
// development a stray control in either is reported on the console.
// - plain: no frame; the head's rule is the only line. For settings groups.
// - boxed: a hairline frame; the head is its top strip. For things that stand on their own.
// - pane: a left hairline, its own scroll, the head pinned. For a detail pane beside a list.
// Add class "is-literal" when the title is a name the user gave, to keep its case, and "is-list"
// when the body is a list of padded rows with no label above it, to trim the body's own inset.
const AppSection = {
  props: {
    title: { type: String, default: "" },
    meta: { type: String, default: "" },
    variant: { type: String, default: "plain" },
    // The heading's level, to fit the page outline.
    level: { type: [Number, String], default: 3 },
    tag: { type: String, default: "section" },
  },
  setup(props, { slots }) {
    const kind = computed(() => (VARIANTS.has(props.variant) ? props.variant : "plain"));
    const headingTag = computed(() => {
      const level = Number(props.level);
      return level >= 1 && level <= 6 ? "h" + level : "h3";
    });
    // Slots are not reactive, so these are checked on every render rather than cached in a computed;
    // a computed keeps the head after a conditional slot goes away.
    const hasMeta = () => Boolean(props.meta || slots.meta);
    const hasHead = () => Boolean(props.title || hasMeta() || slots.actions || slots.lead);
    const headEl = ref(null);
    if (import.meta.env.DEV) {
      const checkActions = () => {
        const stray = headEl.value?.querySelectorAll(
          ":is(.app-section-lead, .app-section-actions) :is(.q-button:not(.plain), .q-dropdown-menu-action:not(.plain))",
        );
        if (stray?.length) {
          console.warn(`AppSection "${props.title}": head actions take plain buttons and dropdown menus only.`, [...stray]);
        }
      };
      onMounted(checkActions);
      onUpdated(checkActions);
    }
    return { kind, headingTag, hasMeta, hasHead, headEl };
  },
  template: `
    <component :is="tag" :class="['app-section', 'is-' + kind]">
      <header v-if="hasHead()" ref="headEl" class="app-section-head">
        <div v-if="$slots.lead" class="app-section-lead">
          <slot name="lead" />
        </div>
        <component :is="headingTag" v-if="title" class="app-section-title" :title="title">
          <span class="app-section-mark" aria-hidden="true"></span>
          <span class="app-section-label">
            <span class="app-section-bracket" aria-hidden="true">[</span><span class="app-section-label-text">{{ title }}</span><span class="app-section-bracket" aria-hidden="true">]</span>
          </span>
        </component>
        <div v-if="hasMeta()" class="app-section-meta" :title="meta || undefined">
          <slot name="meta">{{ meta }}</slot>
        </div>
        <div v-if="$slots.actions" class="app-section-actions">
          <slot name="actions" />
        </div>
      </header>
      <div v-if="$slots.default" class="app-section-body">
        <slot />
      </div>
    </component>
  `,
};

export default AppSection;
