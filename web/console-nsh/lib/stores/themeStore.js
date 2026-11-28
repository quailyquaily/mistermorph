import { setColorScheme, setTheme } from "nsh";
import { DEFAULT_THEME, nshTheme, storedTheme, themeOf } from "../core/themes.js";
import { localStore } from "../platform";
import { reactiveRecord } from "./reactive-record.js";

// Under the "mistermorph" prefix: the web host reads back only the keys it knows the prefix of (host.js).
const THEME_STORAGE_KEY = "mistermorph.theme";
// What a device chose before there were themes ("light" or "dark"): read once, to give a device
// that chose dark the dark theme; never written again.
const COLOR_SCHEME_STORAGE_KEY = "mistermorph.colorScheme";

/** Shows `id`'s theme at once: its palette, and its own appearance (light or dark). */
function show(id) {
  const theme = themeOf(id);
  setTheme(nshTheme(theme));
  setColorScheme(theme.scheme);
}

/** The console's theme: Aojashin (light) unless this device chose another. */
const themeState = reactiveRecord(
  { theme: DEFAULT_THEME },
  {
    /** Shows the console in the theme `id` at once and keeps the choice on this device. */
    setTheme(id) {
      this.theme = themeOf(id).id;
      show(this.theme);
      localStore.setItem(THEME_STORAGE_KEY, this.theme);
    },
    /** The stored choice, applied before the first page mounts; nothing stored is the default theme. */
    hydrateTheme() {
      this.theme = storedTheme(localStore.getItem(THEME_STORAGE_KEY), localStore.getItem(COLOR_SCHEME_STORAGE_KEY));
      show(this.theme);
    },
  },
);

export { themeState, THEME_STORAGE_KEY, COLOR_SCHEME_STORAGE_KEY };
