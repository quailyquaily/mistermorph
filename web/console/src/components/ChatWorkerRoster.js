import { computed, nextTick, onBeforeUpdate, onUpdated, ref } from "vue";

import { localeState, translate } from "../core/context";
import { rosterWorkers, workerProcessLabel } from "../core/chat-workers";
import { workerAvatarURL } from "../core/worker-avatars";
import "./ChatWorkerRoster.css";

// WorkerAvatar shows the logo style the runtime allocated to a worker. It is decorative: the
// worker's name is always beside it.
const WorkerAvatar = {
  props: {
    avatarStyle: { type: String, required: true },
  },
  setup(props) {
    const src = computed(() => workerAvatarURL(props.avatarStyle));
    return { src };
  },
  template: `
    <img
      :class="['chat-worker-avatar', 'is-' + avatarStyle]"
      :src="src"
      alt=""
      aria-hidden="true"
      width="20"
      height="20"
      draggable="false"
    />
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
    // Names follow the Console's language; the worker's id and avatar do not.
    const workers = computed(() => rosterWorkers(props.activity, props.status, localeState.lang));
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

    function sectionLabel(kind) {
      return t(`chat_worker_section_${kind}`);
    }

    function workerTitle(worker) {
      return `${worker.displayName} · ${kindLabel(worker)} · ${stateLabel(worker.state)}`;
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
      sectionLabel,
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
            <WorkerAvatar :avatar-style="worker.avatarStyle" />
            <span class="chat-worker-name">{{ worker.displayName }}</span>
            <span class="chat-worker-state-dot" aria-hidden="true"></span>
            <span class="chat-worker-sr">{{ stateLabel(worker.state) }}</span>
          </button>
        </li>
        <li v-if="omitted > 0" class="chat-worker-list-item chat-worker-omitted">
          {{ t("chat_workers_omitted", { count: omitted }) }}
        </li>
      </ul>

      <div v-if="selected" :id="detailId" class="chat-worker-detail" role="region" :aria-label="selected.displayName">
        <div class="chat-worker-detail-head">
          <WorkerAvatar :avatar-style="selected.avatarStyle" />
          <span class="chat-worker-detail-name">{{ selected.displayName }}</span>
          <span class="chat-worker-detail-meta">{{ kindLabel(selected) }}</span>
          <span :class="['chat-worker-detail-state', 'is-' + selected.state]">{{ stateLabel(selected.state) }}</span>
          <span
            v-for="process in selected.processes"
            :key="process.pid + ':' + process.program + ':' + process.activityId"
            class="chat-worker-detail-pid"
          >{{ workerProcessLabel(process) }}</span>
        </div>
        <div v-if="selected.sections.length > 0" ref="outputRef" class="chat-worker-sections">
          <section
            v-for="section in selected.sections"
            :key="section.kind"
            :class="['chat-worker-section', 'is-' + section.kind]"
          >
            <h4 v-if="selected.sections.length > 1" class="chat-worker-section-label">{{ sectionLabel(section.kind) }}</h4>
            <p class="chat-worker-output">{{ section.text }}</p>
          </section>
        </div>
        <p v-else class="chat-worker-output is-empty">{{ t("chat_worker_no_output") }}</p>
      </div>
    </section>
  `,
};

export default ChatWorkerRoster;
