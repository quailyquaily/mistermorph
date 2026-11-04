import { computed, nextTick, onBeforeUpdate, onUpdated, ref } from "vue";

import { translate } from "../core/context";
import { rosterWorkers, workerAvatar, workerProcessLabel } from "../core/chat-workers";
import "./ChatWorkerRoster.css";

// WorkerAvatar draws a worker's generated avatar: its name decides the hue and the pattern.
const WorkerAvatar = {
  props: {
    name: { type: String, required: true },
  },
  setup(props) {
    const avatar = computed(() => workerAvatar(props.name));
    const style = computed(() => ({ "--worker-hue": String(avatar.value.hue) }));
    return { avatar, style };
  },
  template: `
    <svg class="chat-worker-avatar" :style="style" viewBox="-1 -1 7 7" aria-hidden="true" focusable="false">
      <rect class="chat-worker-avatar-bg" x="-1" y="-1" width="7" height="7" rx="3.5" />
      <rect
        v-for="cell in avatar.cells"
        :key="cell.x + ':' + cell.y"
        class="chat-worker-avatar-cell"
        :x="cell.x"
        :y="cell.y"
        width="1"
        height="1"
      />
    </svg>
  `,
};

// ChatWorkerRoster lists the subagents and coders a task started, below its status card. Each is
// a button with its avatar, name and state; the selected one shows its PIDs and output.
const ChatWorkerRoster = {
  components: { WorkerAvatar },
  props: {
    itemId: { type: [String, Number], default: "" },
    activity: { type: Object, default: null },
    status: { type: String, default: "" },
  },
  setup(props) {
    const t = translate;
    const selectedId = ref("");
    const outputRef = ref(null);
    let keepOutputPinned = true;
    const workers = computed(() => rosterWorkers(props.activity, props.status));
    const omitted = computed(() => Math.max(0, Number(props.activity?.workersOmitted) || 0));
    const selected = computed(() => workers.value.find((worker) => worker.id === selectedId.value) || null);
    const detailId = computed(() => `chat-worker-detail-${String(props.itemId || "task")}`);

    function select(worker) {
      selectedId.value = selectedId.value === worker.id ? "" : worker.id;
      keepOutputPinned = true;
      void nextTick(scrollOutputToBottom);
    }

    function stateLabel(state) {
      return t(`chat_worker_state_${state}`);
    }

    function kindLabel(worker) {
      return worker.kind === "coder" ? t("chat_worker_kind_coder") : t("chat_worker_kind_subagent");
    }

    function workerTitle(worker) {
      return `${worker.name} · ${kindLabel(worker)} · ${stateLabel(worker.state)}`;
    }

    function outputAtBottom() {
      const node = outputRef.value;
      return !node || node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
    }

    function scrollOutputToBottom() {
      const node = outputRef.value;
      if (node) {
        node.scrollTop = node.scrollHeight;
      }
    }

    // Like the progress panel, new output keeps the view at the end unless the reader scrolled up.
    onBeforeUpdate(() => {
      keepOutputPinned = outputAtBottom();
    });
    onUpdated(() => {
      if (keepOutputPinned) {
        void nextTick(scrollOutputToBottom);
      }
    });

    return {
      t,
      workers,
      omitted,
      selected,
      selectedId,
      detailId,
      outputRef,
      select,
      stateLabel,
      kindLabel,
      workerTitle,
      workerProcessLabel,
    };
  },
  template: `
    <section v-if="workers.length > 0" class="chat-worker-roster" :aria-label="t('chat_workers_title')">
      <ul class="chat-worker-list">
        <li v-for="worker in workers" :key="itemId + ':worker:' + worker.id" class="chat-worker-list-item">
          <button
            type="button"
            :class="['chat-worker-chip', 'is-' + worker.state, { 'is-selected': worker.id === selectedId }]"
            :title="workerTitle(worker)"
            :aria-pressed="worker.id === selectedId"
            :aria-controls="worker.id === selectedId ? detailId : null"
            @click="select(worker)"
          >
            <WorkerAvatar :name="worker.name" />
            <span class="chat-worker-name">{{ worker.name }}</span>
            <span class="chat-worker-state-dot" aria-hidden="true"></span>
            <span class="chat-worker-sr">{{ stateLabel(worker.state) }}</span>
          </button>
        </li>
        <li v-if="omitted > 0" class="chat-worker-list-item chat-worker-omitted">
          {{ t("chat_workers_omitted", { count: omitted }) }}
        </li>
      </ul>

      <div v-if="selected" :id="detailId" class="chat-worker-detail" role="region" :aria-label="selected.name">
        <div class="chat-worker-detail-head">
          <WorkerAvatar :name="selected.name" />
          <span class="chat-worker-detail-name">{{ selected.name }}</span>
          <span class="chat-worker-detail-meta">{{ kindLabel(selected) }}</span>
          <span :class="['chat-worker-detail-state', 'is-' + selected.state]">{{ stateLabel(selected.state) }}</span>
          <span
            v-for="process in selected.processes"
            :key="process.pid + ':' + process.program + ':' + process.activityId"
            class="chat-worker-detail-pid"
          >{{ workerProcessLabel(process) }}</span>
        </div>
        <p v-if="selected.note" ref="outputRef" class="chat-worker-output">{{ selected.note }}</p>
        <p v-else class="chat-worker-output is-empty">{{ t("chat_worker_no_output") }}</p>
      </div>
    </section>
  `,
};

export default ChatWorkerRoster;
