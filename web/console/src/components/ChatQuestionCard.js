import { computed, ref, watch } from "vue";

import { translate } from "../core/context";
import MarkdownContent from "./MarkdownContent";
import "./ChatQuestionCard.css";

// A question the agent asked while working (ask_user). While it is open, each choice is a button
// (or its number key) and the field below takes a typed answer; once closed it shows the answer.
const ChatQuestionCard = {
  components: { MarkdownContent },
  props: {
    question: { type: Object, required: true },
    // The task still runs: an open question of an ended task got no answer.
    live: { type: Boolean, default: false },
  },
  emits: ["answer"],
  setup(props, { emit }) {
    const draft = ref("");
    const busy = ref(false);
    const error = ref("");
    const options = computed(() => (Array.isArray(props.question?.options) ? props.question.options : []));
    const status = computed(() => {
      const value = String(props.question?.status || "");
      if (value === "open" && !props.live) return "expired";
      return value === "open" || value === "answered" ? value : "expired";
    });
    const open = computed(() => status.value === "open");
    const answerText = computed(() => String(props.question?.answer || "").trim());
    const chosen = computed(() => (Number.isInteger(props.question?.option) ? props.question.option : null));

    watch(
      () => props.question?.id,
      () => {
        draft.value = "";
        busy.value = false;
        error.value = "";
      }
    );
    watch(open, (value) => {
      if (!value) busy.value = false;
    });

    // done reports whether the answer was taken; a closed question cannot take one.
    function send(answer) {
      if (!open.value || busy.value) return;
      busy.value = true;
      error.value = "";
      emit("answer", {
        questionID: props.question.id,
        ...answer,
        done(ok, message) {
          busy.value = false;
          if (ok) {
            draft.value = "";
          } else {
            error.value = message || translate("chat_question_closed");
          }
        },
      });
    }

    function choose(index) {
      send({ option: index });
    }

    function sendDraft() {
      const text = draft.value.trim();
      if (text) send({ text });
    }

    function onCardKeydown(event) {
      if (!open.value || event.target?.tagName === "INPUT" || event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number.parseInt(event.key, 10) - 1;
      if (index >= 0 && index < options.value.length) {
        event.preventDefault();
        choose(index);
      }
    }

    return { answerText, busy, choose, chosen, draft, error, onCardKeydown, open, options, sendDraft, status, t: translate };
  },
  template: `
    <section
      :class="['chat-question', 'is-' + status]"
      role="region"
      :aria-label="t('chat_question_title')"
      :aria-busy="busy ? 'true' : null"
      @keydown="onCardKeydown"
    >
      <div v-if="open" class="chat-question-grid">
        <span class="chat-question-key"><span class="chat-question-label">{{ t('chat_question_asked') }}</span></span>
        <MarkdownContent class="chat-question-value chat-question-text" :source="question.text" />
        <button
          v-for="(option, index) in options"
          :key="option.label"
          type="button"
          class="chat-question-option"
          :disabled="busy"
          @click="choose(index)"
        >
          <span class="chat-question-key" aria-hidden="true"><span class="chat-question-label">[{{ index + 1 }}]</span></span>
          <span class="chat-question-value">
            <span class="chat-question-option-label">{{ option.label }}</span>
            <span v-if="option.description" class="chat-question-option-detail">{{ option.description }}</span>
          </span>
        </button>
        <span v-if="!question.choices_only" class="chat-question-key is-reply"><span class="chat-question-label">{{ t('chat_question_you') }}</span></span>
        <form v-if="!question.choices_only" class="chat-question-value chat-question-reply" @submit.prevent="sendDraft">
          <input
            v-model="draft"
            class="chat-question-input"
            type="text"
            :placeholder="options.length ? t('chat_question_other_placeholder') : t('chat_question_reply_placeholder')"
            :aria-label="options.length ? t('chat_question_other_placeholder') : t('chat_question_reply_placeholder')"
            :disabled="busy"
            enterkeyhint="send"
          />
          <AppButton type="submit" class="primary xs" :disabled="busy || !draft.trim()">
            {{ t('chat_question_send') }}
          </AppButton>
        </form>
        <p v-if="error" class="chat-question-value chat-question-error" role="alert">{{ error }}</p>
      </div>
      <dl v-else class="chat-question-grid">
        <div class="chat-question-row">
          <dt class="chat-question-key"><span class="chat-question-label">{{ t('chat_question_asked') }}</span></dt>
          <dd class="chat-question-value chat-question-text">{{ question.text }}</dd>
        </div>
        <div class="chat-question-row">
          <dt class="chat-question-key"><span class="chat-question-label">{{ t('chat_question_you') }}</span></dt>
          <dd v-if="status === 'answered'" class="chat-question-value chat-question-answer">{{ answerText }}</dd>
          <dd v-else class="chat-question-value"><span class="chat-question-label is-none">{{ t('chat_question_no_answer_tag') }}</span></dd>
        </div>
      </dl>
    </section>
  `,
};

export default ChatQuestionCard;
