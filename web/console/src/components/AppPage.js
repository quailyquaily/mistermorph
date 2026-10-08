import AppErrorNotice from "./AppErrorNotice";
import "./AppPage.css";

const AppPage = {
  components: { AppErrorNotice },
  props: {
    // A page-level error (a failed load, the network): shown floating over the page, not in it.
    error: {
      type: String,
      default: "",
    },
    title: {
      type: String,
      default: "",
    },
    hideDesktopBar: {
      type: Boolean,
      default: false,
    },
    hideMobileBar: {
      type: Boolean,
      default: false,
    },
    overlayBar: {
      type: Boolean,
      default: false,
    },
  },
  template: `
    <section
      :class="[
        'page-view',
        {
          'page-view-hide-desktop-bar': hideDesktopBar,
          'page-view-hide-mobile-bar': hideMobileBar,
          'page-view-overlay-bar': overlayBar,
        },
      ]"
    >
      <header class="page-bar">
        <div class="page-bar-leading">
          <slot name="leading">
            <h2 class="page-title page-bar-title workspace-section-title">{{ title }}</h2>
          </slot>
        </div>
        <div v-if="$slots.actions" class="page-bar-actions">
          <slot name="actions" />
        </div>
      </header>
      <div class="page-body">
        <slot />
      </div>
      <AppErrorNotice :message="error" />
    </section>
  `,
};

export default AppPage;
