import { onBeforeUpdate, onUpdated, shallowRef, watch } from "vue";

import { createArrivalTracker } from "../core/arrivals";

import { recordComponentUpdate } from "../core/performance";
import ChatHistoryItem from "./ChatHistoryItem";

function itemID(item) {
  return String(item?.id || "").trim();
}

const RECORD_COMPONENT_PERF = import.meta.env.DEV === true;
// Longer than the arrival animation, so rapid streaming updates do not cut it short.
const ARRIVAL_WINDOW_MS = 600;

const ChatHistoryList = {
  components: {
    ChatHistoryItem,
  },
  emits: ["approval-approve", "approval-deny", "copy", "preview-file", "rendered", "time-click", "toggle-status"],
  props: {
    items: {
      type: Array,
      default: () => [],
    },
    loading: {
      type: Boolean,
      default: false,
    },
    loadingText: {
      type: String,
      default: "",
    },
    emptyText: {
      type: String,
      default: "",
    },
    footerText: {
      type: String,
      default: "",
    },
    submitEndpointRef: {
      type: String,
      default: "",
    },
    selectedTopicId: {
      type: String,
      default: "",
    },
    copiedItemId: {
      type: String,
      default: "",
    },
    expandedState: {
      type: Object,
      default: () => ({}),
    },
    autoPreviewItemId: {
      type: String,
      default: "",
    },
    streamProfiler: {
      type: Boolean,
      default: false,
    },
    copyLabel: {
      type: String,
      default: "Copy",
    },
    filePreviewLabel: {
      type: String,
      default: "Preview file",
    },
    approvalApproveLabel: {
      type: String,
      default: "Approve",
    },
    approvalDenyLabel: {
      type: String,
      default: "Deny",
    },
    approvalTitle: {
      type: String,
      default: "Approval required",
    },
  },
  setup(props, { emit }) {
    let updateStartedAt = 0;
    // The placeholder thread while a topic's history loads: a question and a reply of a few lines,
    // three times. Fixed widths, so it reads as a conversation without looking random.
    const skeletonTurns = [
      { ask: 34, reply: [92, 86, 58] },
      { ask: 52, reply: [88, 94, 76, 40] },
      { ask: 26, reply: [84, 62] },
    ];

    // Messages that just joined the thread animate in; history loads and topic switches do not.
    const arrivals = createArrivalTracker({ edge: "end" });
    const arrivingUntil = shallowRef(new Map());
    watch(
      () => [props.items, props.selectedTopicId, props.loading],
      () => {
        if (props.loading) {
          return;
        }
        const now = performance.now();
        const next = new Map([...arrivingUntil.value].filter(([, until]) => until > now));
        for (const id of arrivals.update(props.items.map(itemID), props.selectedTopicId)) {
          next.set(id, now + ARRIVAL_WINDOW_MS);
        }
        arrivingUntil.value = next;
      },
      { immediate: true, flush: "pre" },
    );

    function arriving(item) {
      const until = arrivingUntil.value.get(itemID(item));
      return until !== undefined && until > performance.now();
    }

    function copied(item) {
      return itemID(item) !== "" && itemID(item) === props.copiedItemId;
    }

    function expandedPanel(item) {
      const value = String(props.expandedState[itemID(item)] || "").trim();
      return value === "plan" || value === "activity" || value === "reasoning" ? value : "";
    }

    function autoPreview(item) {
      const id = itemID(item);
      return id !== "" && id === props.autoPreviewItemId;
    }

    function emitRendered(id) {
      emit("rendered", id);
    }

    function emitCopy(item) {
      emit("copy", item);
    }

    function emitPreviewFile(item) {
      emit("preview-file", item);
    }

    function emitToggleStatus(id, panel) {
      emit("toggle-status", id, panel);
    }

    function emitTimeClick(item) {
      emit("time-click", item);
    }

    function emitApprovalApprove(item) {
      emit("approval-approve", item);
    }

    function emitApprovalDeny(item) {
      emit("approval-deny", item);
    }

    onBeforeUpdate(() => {
      if (RECORD_COMPONENT_PERF) {
        updateStartedAt = performance.now();
      }
    });

    onUpdated(() => {
      if (RECORD_COMPONENT_PERF) {
        recordComponentUpdate(
          "chat.history_list",
          updateStartedAt ? performance.now() - updateStartedAt : 0
        );
        updateStartedAt = 0;
      }
    });

    return {
      arriving,
      autoPreview,
      copied,
      emitApprovalApprove,
      emitApprovalDeny,
      emitCopy,
      emitPreviewFile,
      skeletonTurns,
      emitRendered,
      emitTimeClick,
      emitToggleStatus,
      expandedPanel,
    };
  },
  template: `
    <div v-if="loading" class="chat-history-skeleton" role="status" :aria-label="loadingText">
      <div v-for="(turn, index) in skeletonTurns" :key="index" class="chat-history-skeleton-turn">
        <span class="chat-history-skeleton-bubble" :style="{ width: turn.ask + '%' }"></span>
        <span
          v-for="(width, line) in turn.reply"
          :key="line"
          class="chat-history-skeleton-line"
          :style="{ width: width + '%' }"
        ></span>
      </div>
    </div>
    <template v-else>
    <ChatHistoryItem
      v-for="item in items"
      :key="item.id"
      :item="item"
      :arriving="arriving(item)"
      :submit-endpoint-ref="submitEndpointRef"
      :selected-topic-id="selectedTopicId"
      :copied="copied(item)"
      :expanded-panel="expandedPanel(item)"
      :auto-preview="autoPreview(item)"
      :stream-profiler="streamProfiler"
      :copy-label="copyLabel"
      :file-preview-label="filePreviewLabel"
      :approval-approve-label="approvalApproveLabel"
      :approval-deny-label="approvalDenyLabel"
      :approval-title="approvalTitle"
      @rendered="emitRendered"
      @copy="emitCopy"
      @preview-file="emitPreviewFile"
      @toggle-status="emitToggleStatus"
      @time-click="emitTimeClick"
      @approval-approve="emitApprovalApprove"
      @approval-deny="emitApprovalDeny"
    />
    </template>
    <p v-if="items.length === 0 && !loading" class="muted">{{ emptyText }}</p>
    <p v-if="footerText && !loading" class="chat-history-disclaimer">{{ footerText }}</p>
  `,
};

export default ChatHistoryList;
