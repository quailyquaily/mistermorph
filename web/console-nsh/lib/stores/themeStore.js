import { setColorScheme } from "nsh";
import { localStore } from "../platform";
import { reactiveRecord } from "./reactive-record.js";

// Under the "mistermorph" prefix: the web host reads back only the keys it knows the prefix of (host.js).
const COLOR_SCHEME_STORAGE_KEY = "mistermorph.colorScheme";

/** The console's appearance: "light" (the default, whatever the system's) or "dark". */
function normalizeScheme(raw) {
  return String(raw || "").trim().toLowerCase() === "dark" ? "dark" : "light";
}

const themeState = reactiveRecord(
  { scheme: "light" },
  {
    /** Shows the console in `scheme` at once and keeps the choice on this device. */
    setScheme(scheme) {
      this.scheme = normalizeScheme(scheme);
      setColorScheme(this.scheme);
      localStore.setItem(COLOR_SCHEME_STORAGE_KEY, this.scheme);
    },
    /** The stored choice, applied before the first page mounts; nothing stored is light. */
    hydrateScheme() {
      this.scheme = normalizeScheme(localStore.getItem(COLOR_SCHEME_STORAGE_KEY));
      setColorScheme(this.scheme);
    },
  },
);

export { themeState, normalizeScheme, COLOR_SCHEME_STORAGE_KEY };
