// The one place the Console's keyboard shortcuts (lib/shortcuts.ts) are bound. Each action's keys
// are bound once, with nsh's `keymap` defaults: a key that types, moves the caret or edits text
// stays the focused text field's, keys an input method is composing never match, and a held key
// fires once. Only actions that can act now are bound, so their keys do what they did before
// everywhere else, and nothing is bound while a dialog, menu or the composer's suggestions are
// open (they own the keyboard) or while Settings records a new shortcut. A focused text editor
// keeps its own keys: nsh puts the components' bindings after the app's.
import { cleanup, effect, keymap, untracked } from "nsh";
import { authValid, endpointState } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { navigate, route } from "../../lib/router";
import {
  inShellless,
  inSetup,
  inStandalone,
  isMobile,
  goTo,
  navItems,
  setSidebarCollapsed,
  sidebarCollapsed,
} from "../../lib/shell";
import {
  effectiveShortcuts,
  loadShortcuts,
  provideShortcut,
  SHORTCUT_ACTIONS,
  shortcutProvider,
  shortcutRecording,
} from "../../lib/shortcuts";
import { popupOpen } from "../ui";

/** Where the Settings page lists the shortcuts. */
export const SHORTCUTS_SETTINGS_PATH = "/settings/shortcuts";

/** A workspace page (not login, setup or the troubleshooting page) with an agent selected. */
const inWorkspace = () => Boolean(route()) && !inShellless() && !inSetup() && authValid.value && Boolean(endpointState.selectedRef);

/** Binds the shortcuts and provides the frame's own actions. Call once, in the shell. */
export function startShortcutDispatch() {
  loadShortcuts();
  for (const action of SHORTCUT_ACTIONS) {
    if (!action.page) continue;
    const page = action.page;
    provideShortcut(
      action.id,
      () => {
        const item = untracked(navItems).find((entry) => entry.pagePath === page);
        if (item) goTo(item);
      },
      inWorkspace,
    );
  }
  provideShortcut(
    "frame.toggleSidebar",
    () => setSidebarCollapsed(!untracked(sidebarCollapsed)),
    () => inWorkspace() && !inStandalone() && !isMobile(),
  );
  provideShortcut(
    "help.shortcuts",
    () => {
      const path = endpointRoutePath(endpointState.selectedRef, SHORTCUTS_SETTINGS_PATH);
      if (path && untracked(() => route()?.path) !== path) void navigate(path);
    },
    inWorkspace,
  );

  effect(() => {
    if (popupOpen() || shortcutRecording()) return;
    for (const binding of effectiveShortcuts()) {
      if (!binding.keys || binding.shadowedBy) continue;
      const provider = shortcutProvider(binding.id);
      if (!provider || !provider.available()) continue;
      const run = provider.run;
      try {
        cleanup(keymap.bind(binding.keys, () => untracked(run)));
      } catch (error) {
        // nsh refuses keys the platform keeps; Settings never saves them, but say so if one gets here.
        console.warn(`keyboard shortcuts: cannot bind ${binding.keys} (${binding.id}):`, (error as Error)?.message || error);
      }
    }
  });
}
