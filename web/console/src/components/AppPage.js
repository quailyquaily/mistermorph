import { getCurrentInstance, onBeforeUnmount, watch } from "vue";

import { dismissNotice, pushNotice } from "../core/notices";
import "./AppPage.css";

const AppPage = {
  props: {
    // A page-level error (a failed load, the network): shown in the floating notice stack, not in
    // the page, and kept until it clears or is dismissed.
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
  setup(props) {
    const noticeID = `page-error-${getCurrentInstance()?.uid ?? Date.now()}`;
    watch(
      () => String(props.error || "").trim(),
      (text) => {
        if (text) {
          pushNotice({ id: noticeID, type: "error", text, timeout: 0 });
        } else {
          dismissNotice(noticeID);
        }
      },
      { immediate: true },
    );
    onBeforeUnmount(() => dismissNotice(noticeID));
    return {};
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
    </section>
  `,
};

export default AppPage;
