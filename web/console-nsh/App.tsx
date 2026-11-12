// The entry: read the host's boot data, restore the session and the language, start the router,
// then mount the frame. Page logic lives in pages/, shared state in lib/.
import { effect, keyboardFrame, mount, untracked, View } from "nsh";
import "./assets/fonts/ibm-plex-sans-latin-400-normal.woff2";
import "./assets/fonts/ibm-plex-sans-latin-400-italic.woff2";
import "./assets/fonts/ibm-plex-sans-latin-500-normal.woff2";
import "./assets/fonts/ibm-plex-sans-latin-600-normal.woff2";
import "./assets/fonts/ibm-plex-mono-latin-400-normal.woff2";
import "./assets/fonts/ibm-plex-mono-latin-500-normal.woff2";
import { Scrollbar } from "nsh/base";
import { SCROLLBAR } from "./components/motion/ScrollEdges";
import { Shell } from "./components/Shell";
import { authState, configureApiBase, endpointState, localeState } from "./lib/core/context.js";
import { currentLocale } from "./lib/i18n/index.js";
import { installSystemNotifications } from "./lib/core/system-notifications.js";
import { boot, isMobile, reportFrontendReady, setDocumentLanguage, startVisibilityTracking } from "./lib/platform";
import { route, router, startRouter } from "./lib/router";
import { inShellless, inStandalone, startShell, systemInsets } from "./lib/shell";
import { startSystemBack } from "./lib/systemBack";
import { PageView } from "./pages/routes";

// Every scroll bar is the console's (styles/base.css: thin hairline thumbs shown while the pointer is
// over the area), including those nsh draws for itself (a reply's tables and code blocks).
Scrollbar.setTheme(SCROLLBAR);

// The frame's padding: on Android, the room the system bars and the keyboard take (lib/systemInsets.ts);
// on iOS, the keyboard's.
function frameStyle() {
  const insets = systemInsets();
  if (insets) {
    const { top, right, bottom, left } = insets.frame;
    return { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left };
  }
  return isMobile() ? { paddingBottom: keyboardFrame().height } : undefined;
}
/** The frame's bottom padding, in its testID for the tests (they read no styles). */
const frameTestID = () => `app-frame.bottom-${Math.round(Number(frameStyle()?.paddingBottom) || 0)}`;

function App() {
  startShell();
  startSystemBack();
  // Screen readers, hyphenation and the browser's translate offer read the page language.
  effect(() => {
    const language = currentLocale();
    untracked(() => setDocumentLanguage(language));
  });
  let reported = false;
  effect(() => {
    if (route() && !reported) {
      reported = true;
      untracked(reportFrontendReady);
    }
  });
  return (
    // The phone app's surface does not shrink when the software keyboard opens: the app does, so
    // the composer and the fields stay above it (dialogs make room themselves, in their own layer).
    // On Android the surface also runs under the status and navigation bars: the frame keeps the
    // pages out from under them.
    <View class="flex-1 bg-background" style={frameStyle()} testID={frameTestID()}>
      <If when={route()}>
        <Shell shellless={inShellless()} standalone={inStandalone()}>
          <PageView />
        </Shell>
      </If>
    </View>
  );
}

async function start() {
  await boot();
  configureApiBase();
  startVisibilityTracking();
  localeState.hydrateLanguage();
  authState.hydrate();
  endpointState.hydrateEndpointSelection();
  installSystemNotifications(router);
  startRouter();
  mount(App);
}

void start();
