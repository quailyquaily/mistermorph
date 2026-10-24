import { computed, onMounted, ref, watch } from "vue";

import QDropdownMenu from "./QDropdownMenu";

// QLanguageSelector: a dropdown of the interface languages, each with a small emblem. lang sets the
// shown one; presist also remembers a choice in localStorage ("quail-language", kept so existing
// choices survive) and starts from it. Choosing emits "change" with { title, value }.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const LANGUAGES = [
  { flag: "🗽", title: "English", value: "en" },
  { flag: "🐼", title: "简体中文", value: "zh" },
  { flag: "🧋", title: "正體中文", value: "zh-tw" },
  { flag: "🌸", title: "日本語", value: "ja" },
  { flag: "⚜️", title: "Français", value: "fr" },
];
const STORAGE_KEY = "quail-language";

function storedLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const QLanguageSelector = {
  name: "QLanguageSelector",
  components: { QDropdownMenu },
  props: {
    lang: { type: String, default: "en" },
    noFlag: { type: Boolean, default: false },
    auto: { type: Boolean, default: false },
    presist: { type: Boolean, default: false },
  },
  emits: ["change"],
  setup(props, { emit }) {
    const selected = ref(null);
    function choose(item) {
      if (props.presist) {
        try {
          localStorage.setItem(STORAGE_KEY, item.value);
        } catch {
          // Not remembered; the choice still applies.
        }
      }
      emit("change", { title: item.title, value: item.value });
    }
    const items = computed(() =>
      [...(props.auto ? [{ flag: "🌐", title: "Auto", value: "" }] : []), ...LANGUAGES].map((item) => ({
        ...item,
        // An en space: plain spaces collapse to one, too tight after an emoji.
        title: props.noFlag ? item.title : `${item.flag}\u2002${item.title}`,
        action: choose,
      })),
    );
    watch(
      () => props.lang,
      (lang) => {
        selected.value = items.value.find((item) => item.value === lang);
      },
    );
    onMounted(() => {
      const stored = props.presist ? storedLanguage() : null;
      selected.value = items.value.find((item) => item.value === props.lang || item.value === stored) || items.value[0];
    });
    return { items, selected };
  },
  template: `<QDropdownMenu :items="items" :initial-item="selected" />`,
};

export default QLanguageSelector;
