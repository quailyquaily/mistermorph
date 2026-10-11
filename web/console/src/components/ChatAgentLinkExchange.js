import { computed, ref } from "vue";
import { translate } from "../core/context";
import ChatRichContent from "./ChatRichContent";
import "./ChatAgentLinkExchange.css";

function timeText(raw) {
  const date = new Date(String(raw || "").trim());
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// The messages a task exchanged with other agents over Agent Link, shown before its reply. It opens
// unfolded; the header folds it.
const ChatAgentLinkExchange = {
  components: { ChatRichContent },
  emits: ["rendered"],
  props: {
    messages: {
      type: Array,
      default: () => [],
    },
    endpointRef: {
      type: String,
      default: "",
    },
    topicId: {
      type: String,
      default: "",
    },
    streamProfiler: {
      type: Boolean,
      default: false,
    },
  },
  setup(props, { emit }) {
    const t = translate;
    const open = ref(true);
    const peers = computed(() => {
      const names = [];
      props.messages.forEach((message) => {
        const name = message.peer || t("chat_agentlink_peer_unknown");
        if (!names.includes(name)) {
          names.push(name);
        }
      });
      return names.join(", ");
    });
    const count = computed(() => props.messages.filter((message) => message.direction !== "pending").length);

    function toggle() {
      open.value = !open.value;
    }

    function label(message) {
      const peer = message.peer || t("chat_agentlink_peer_unknown");
      if (message.direction === "sent") {
        return t("chat_agentlink_to", { peer });
      }
      if (message.direction === "reply") {
        return t("chat_agentlink_from", { peer });
      }
      return t("chat_agentlink_pending", { peer });
    }

    return {
      t,
      open,
      peers,
      count,
      toggle,
      label,
      timeText,
      emitRendered: () => emit("rendered"),
    };
  },
  template: `
    <section v-if="messages.length > 0" class="chat-agentlink">
      <span
        :class="['chat-agentlink-head', { 'is-expanded': open }]"
        role="button"
        tabindex="0"
        :aria-expanded="open"
        @click="toggle"
        @keydown.enter.prevent="toggle"
        @keydown.space.prevent="toggle"
      >
        <span class="chat-agentlink-head-label">{{ t("chat_agentlink_title") }}</span>
        <span class="chat-agentlink-head-value">{{ peers }}</span>
        <span v-if="count > 0" class="chat-agentlink-head-count">{{ t("chat_agentlink_count", { count }) }}</span>
        <PhCaretDown class="chat-agentlink-head-icon icon" aria-hidden="true" />
      </span>

      <Transition name="chat-agentlink-fold">
        <div v-if="open" class="chat-agentlink-shell">
          <ol class="chat-agentlink-list">
            <li
              v-for="message in messages"
              :key="message.key"
              :class="'chat-agentlink-message is-' + message.direction"
            >
              <span class="chat-agentlink-dot" aria-hidden="true"></span>
              <div class="chat-agentlink-copy">
                <div class="chat-agentlink-line">
                  <span class="chat-agentlink-label">{{ label(message) }}</span>
                  <time v-if="timeText(message.at)" class="chat-agentlink-time">{{ timeText(message.at) }}</time>
                </div>
                <ChatRichContent
                  v-if="message.text"
                  class="chat-history-markdown chat-agentlink-text"
                  :source="message.text"
                  :endpoint-ref="endpointRef"
                  :fallback-topic-id="topicId"
                  :stream-profiler="streamProfiler"
                  format="auto"
                  theme="blueprint"
                  @rendered="emitRendered"
                />
              </div>
            </li>
          </ol>
        </div>
      </Transition>
    </section>
  `,
};

export default ChatAgentLinkExchange;
