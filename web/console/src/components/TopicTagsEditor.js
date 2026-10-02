import { computed, getCurrentInstance, ref, watch } from "vue";

import { translate } from "../core/context";
import {
  MAX_TOPIC_TAGS,
  MAX_TOPIC_TAG_LENGTH,
  mergeTopicTags,
  parseTopicTagInput,
  suggestTopicTags,
} from "../core/topic-tags";
import "./TopicTagsEditor.css";

// Edits a topic's ordinary tags as chips. Each change is emitted at once as the whole new list; the
// parent saves it. Typing a comma or pressing Enter adds the typed tag; Backspace on an empty input
// removes the last one. While the input has focus, tags used on other topics are offered in a list
// that the arrow keys, Enter and the mouse pick from.
const TopicTagsEditor = {
  props: {
    tags: { type: Array, default: () => [] },
    known: { type: Array, default: () => [] },
    disabled: Boolean,
    saving: Boolean,
  },
  emits: ["change"],
  setup(props, { emit }) {
    const t = translate;
    const draft = ref("");
    const input = ref(null);
    const focused = ref(false);
    const dismissed = ref(false);
    const active = ref(-1);
    const listID = `topic-tag-suggestions-${getCurrentInstance()?.uid ?? 0}`;

    const full = computed(() => props.tags.length >= MAX_TOPIC_TAGS);
    const suggestions = computed(() => suggestTopicTags(props.known, props.tags, draft.value));
    const open = computed(() => focused.value && !dismissed.value && !props.disabled && suggestions.value.length > 0);

    watch(suggestions, () => {
      active.value = -1;
    });

    function add(additions) {
      draft.value = "";
      dismissed.value = false;
      if (additions.length === 0) return;
      const next = mergeTopicTags(props.tags, additions).slice(0, MAX_TOPIC_TAGS);
      if (next.length !== props.tags.length) emit("change", next);
    }

    function commit(text) {
      add(parseTopicTagInput(text));
    }

    function pick(tag) {
      add([tag]);
      input.value?.focus?.();
    }

    function remove(index) {
      if (props.disabled) return;
      emit("change", props.tags.filter((_, i) => i !== index));
      input.value?.focus?.();
    }

    function onInput(event) {
      const value = event.target.value;
      dismissed.value = false;
      // A typed or pasted comma ends a tag.
      if (/[,，、]/u.test(value)) {
        commit(value);
        return;
      }
      draft.value = value;
    }

    function move(step) {
      const count = suggestions.value.length;
      if (count === 0) return;
      dismissed.value = false;
      active.value = active.value < 0 ? (step > 0 ? 0 : count - 1) : (active.value + step + count) % count;
    }

    function onKeydown(event) {
      if (event.isComposing) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (open.value && active.value >= 0) pick(suggestions.value[active.value]);
        else commit(draft.value);
      } else if (event.key === "Tab" && open.value && active.value >= 0) {
        event.preventDefault();
        pick(suggestions.value[active.value]);
      } else if (event.key === "Backspace" && draft.value === "" && props.tags.length > 0) {
        event.preventDefault();
        remove(props.tags.length - 1);
      } else if (event.key === "Escape") {
        if (open.value) {
          event.stopPropagation();
          dismissed.value = true;
        } else {
          draft.value = "";
        }
      }
    }

    function onFocus() {
      focused.value = true;
      dismissed.value = false;
    }

    function onBlur() {
      focused.value = false;
      commit(draft.value);
    }

    function optionID(index) {
      return `${listID}-${index}`;
    }

    return {
      t, draft, input, listID, full, suggestions, open, active,
      pick, remove, onInput, onKeydown, onFocus, onBlur, optionID, MAX_TOPIC_TAG_LENGTH, MAX_TOPIC_TAGS,
    };
  },
  template: `
    <div class="topic-tags-editor-shell">
      <div :class="['topic-tags-editor', { 'is-disabled': disabled, 'is-saving': saving }]" @click="input && input.focus()">
        <span v-for="(tag, index) in tags" :key="tag" class="topic-tag-chip">
          <span class="topic-tag-chip-text">{{ tag }}</span>
          <button
            type="button"
            class="topic-tag-chip-remove"
            :title="t('chat_topic_tags_remove', { tag })"
            :aria-label="t('chat_topic_tags_remove', { tag })"
            :disabled="disabled"
            @click.stop="remove(index)"
          >
            <PhX class="topic-tag-chip-remove-icon" aria-hidden="true" />
          </button>
        </span>
        <span v-if="full" class="topic-tags-full">{{ t("chat_topic_tags_full", { max: MAX_TOPIC_TAGS }) }}</span>
        <input
          v-else
          ref="input"
          class="topic-tags-input"
          type="text"
          role="combobox"
          autocomplete="off"
          :value="draft"
          :maxlength="MAX_TOPIC_TAG_LENGTH"
          :placeholder="tags.length ? t('chat_topic_tags_more') : t('chat_topic_tags_placeholder')"
          :aria-label="t('chat_topic_tags_add')"
          :aria-expanded="open ? 'true' : 'false'"
          :aria-controls="listID"
          :aria-activedescendant="open && active >= 0 ? optionID(active) : undefined"
          :disabled="disabled"
          enterkeyhint="done"
          @input="onInput"
          @keydown="onKeydown"
          @focus="onFocus"
          @blur="onBlur"
        />
      </div>
      <ul v-if="open" :id="listID" class="topic-tags-suggestions" role="listbox" :aria-label="t('chat_topic_tags_suggestions')">
        <li
          v-for="(tag, index) in suggestions"
          :id="optionID(index)"
          :key="tag"
          :class="['topic-tags-suggestion', { 'is-active': index === active }]"
          role="option"
          :aria-selected="index === active ? 'true' : 'false'"
          @mousedown.prevent="pick(tag)"
          @mousemove="active = index"
        >
          <PhTag class="topic-tags-suggestion-icon" aria-hidden="true" />
          <span class="topic-tags-suggestion-text">{{ tag }}</span>
        </li>
      </ul>
    </div>
  `,
};

export default TopicTagsEditor;
