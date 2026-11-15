// A test entry (tests/harness.ts `openConsole({ glass: true })`): the console in a window that
// draws glass (lib/glass.ts), as a browser with `backdrop-filter` or Android 12 does. A headless
// window has no browser to ask and answers no on its own.
import { forceGlass } from "../lib/glass";
// App.tsx starts the app as it loads, but its start awaits the host's boot data first: the answer
// below is set before any page mounts.
import "../App";

forceGlass(true);
