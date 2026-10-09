import { dismissNotice, holdNotice, noticeState, releaseNotice } from "../core/notices";
import AppNotice from "./AppNotice";
import "./AppNoticeHost.css";

// The floating notice stack. The app shell places it over the content column; a screen without
// the shell (Setup) pins it to the top of the window with the viewport flag.
const AppNoticeHost = {
  components: { AppNotice },
  props: {
    viewport: { type: Boolean, default: false },
  },
  setup() {
    return { state: noticeState, dismissNotice, holdNotice, releaseNotice };
  },
  template: `
    <TransitionGroup
      tag="div"
      name="app-notice-host"
      :class="['app-notice-host', { 'is-viewport': viewport }]"
      aria-live="polite"
    >
      <AppNotice
        v-for="item in state.items"
        :key="item.id"
        floating
        dismissible
        :type="item.type"
        :text="item.text"
        :label="item.label"
        @dismiss="dismissNotice(item.id)"
        @mouseenter="holdNotice(item.id)"
        @mouseleave="releaseNotice(item.id)"
      />
    </TransitionGroup>
  `,
};

export default AppNoticeHost;
