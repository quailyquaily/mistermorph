import { localStore, languages } from "../platform";
import { reactiveRecord } from "./reactive-record.js";

const LANGUAGE_STORAGE_KEY = "quail-language";

function normalizeLang(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value.startsWith("zh")) {
    return "zh";
  }
  if (value.startsWith("ja")) {
    return "ja";
  }
  return "en";
}

const localeState = reactiveRecord(
  { lang: "en" },
  {
    setLanguage(lang) {
      this.lang = normalizeLang(lang);
      localStore.setItem(LANGUAGE_STORAGE_KEY, this.lang);
    },
    hydrateLanguage() {
      const fromStorage = localStore.getItem(LANGUAGE_STORAGE_KEY);
      if (fromStorage) {
        this.lang = normalizeLang(fromStorage);
        return;
      }
      this.lang = normalizeLang(languages()[0] || "");
      localStore.setItem(LANGUAGE_STORAGE_KEY, this.lang);
    },
    applyLanguageChange(item) {
      if (item && typeof item === "object" && "value" in item) {
        this.setLanguage(item.value);
        return;
      }
      this.setLanguage(item);
    },
  },
);

export { localeState, normalizeLang };
