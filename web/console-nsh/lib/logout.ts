// Logging out of the console, from wherever a page offers it (Settings › General, the UI component
// gallery's header): the console ends the session, and this device forgets it and what it was
// shown, then shows the login page in place of the page it left. Only the session and the router:
// a page that offers it does not load another page's state to do so.
import { signal } from "nsh";
import { apiFetch, authState } from "./core/context.js";
import { cacheClear } from "./core/resource-cache.js";
import { navigate } from "./router";

/**
 * Logs out: `POST /auth/logout`, then, whether or not the console answered, forgets the session and
 * the kept answers here and replaces the current place with `/login` (no leave guard asked: the
 * session is gone either way), so going back does not show the page again without a login.
 */
export async function logOut(): Promise<void> {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch (error) {
    console.warn("logout:", (error as Error)?.message || error);
  } finally {
    authState.clear();
    // Logged out: nothing this account was shown stays on the device.
    cacheClear();
    await navigate("/login", { replace: true, force: true });
  }
}

/**
 * A log-out control's own state: `busy` while the logout runs (the control is disabled then), and
 * `run`, which does nothing while one runs. `logout` is what runs (`logOut`; tests give their own).
 */
export function createLogout(logout: () => Promise<void> = logOut) {
  const busy = signal(false);
  async function run() {
    if (busy()) return;
    busy.set(true);
    try {
      await logout();
    } finally {
      busy.set(false);
    }
  }
  return { busy: () => busy(), run };
}
