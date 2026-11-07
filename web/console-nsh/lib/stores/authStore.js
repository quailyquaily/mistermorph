import { computed } from "nsh";
import { localStore } from "../platform";
import { reactiveRecord } from "./reactive-record.js";

const AUTH_STORAGE_KEY = "mistermorph_console_auth_v1";

const authState = reactiveRecord(
  { token: "", expiresAt: "", account: "console" },
  {
    save() {
      localStore.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({ token: this.token, expiresAt: this.expiresAt, account: this.account }),
      );
    },
    clear() {
      this.token = "";
      this.expiresAt = "";
      this.account = "console";
      localStore.removeItem(AUTH_STORAGE_KEY);
    },
    hydrate() {
      const raw = localStore.getItem(AUTH_STORAGE_KEY);
      if (!raw) {
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        this.token = typeof parsed.token === "string" ? parsed.token : "";
        this.expiresAt = typeof parsed.expiresAt === "string" ? parsed.expiresAt : "";
        this.account = typeof parsed.account === "string" ? parsed.account : "console";
      } catch {
        this.clear();
      }
    },
  },
);

const validNow = computed(() => {
  if (!authState.token || !authState.expiresAt) {
    return false;
  }
  const ts = new Date(authState.expiresAt).getTime();
  if (!Number.isFinite(ts)) {
    return false;
  }
  return ts > Date.now();
});

// `.value` as the Vue computed had it; read it in a binding to follow it.
const authValid = {
  get value() {
    return validNow();
  },
};

export { authState, authValid };
