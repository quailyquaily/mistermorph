import { computed } from "vue";

import "./ChatSystemMessage.css";

const ChatSystemMessage = {
  props: {
    text: { type: String, required: true },
    at: { type: String, default: "" },
  },
  setup(props) {
    const timeText = computed(() => {
      if (!props.at) return "";
      const date = new Date(props.at);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleTimeString("en-GB", { hour12: false });
    });
    return { timeText };
  },
  template: `
    <aside class="chat-system-message" aria-label="System message">
      <span class="chat-system-message-marker" aria-hidden="true">↻</span>
      <div class="chat-system-message-content">
        <div class="chat-system-message-meta">
          <span class="chat-system-message-label">System</span>
          <time v-if="timeText" :datetime="at">{{ timeText }}</time>
        </div>
        <p class="chat-system-message-text">{{ text }}</p>
      </div>
    </aside>
  `,
};

export default ChatSystemMessage;
