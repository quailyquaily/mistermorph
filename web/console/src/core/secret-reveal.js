import { apiFetch } from "./context";

// The console's secret storage: which system store it uses, and whether revealing a stored secret
// asks for the console password. Loaded once; a failed load is tried again next time.
let infoPromise = null;

export function loadSecretInfo() {
  if (!infoPromise) {
    infoPromise = apiFetch("/secrets/info").catch(() => {
      infoPromise = null;
      return null;
    });
  }
  return infoPromise;
}

// Asks the console for one stored secret, by its config path. A wrong password answers 403.
export function revealSecret(path, password = "") {
  return apiFetch("/secrets/reveal", { method: "POST", body: { path, password } });
}

// The keys already in the console's config.yaml, for the secret picker: each listed once with a
// masked hint, the fields using it and when it was first saved. No key value is included.
export function loadSecretKeys() {
  return apiFetch("/secrets/keys");
}
