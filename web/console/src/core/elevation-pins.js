// The runtime identities this browser trusts to receive a sudo password, one per endpoint, like
// SSH's known_hosts (docs/feat/feat_20261026_elevation_client_approval.md §3.5). The first offer
// from an endpoint pins its identity; a different one later is refused until the person trusts it.
const ELEVATION_PINS_STORAGE_KEY = "mistermorph_console_elevation_pins_v1";

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readPins(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(ELEVATION_PINS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// pinnedElevationIdentity is the identity pinned for endpointRef, or "".
function pinnedElevationIdentity(endpointRef, storage = defaultStorage()) {
  const ref = String(endpointRef || "").trim();
  const value = ref ? readPins(storage)[ref] : "";
  return typeof value === "string" ? value.trim() : "";
}

// pinElevationIdentity trusts identity for endpointRef from now on. It reports whether the pin was
// stored; without storage the person is asked to compare the fingerprint again next time.
function pinElevationIdentity(endpointRef, identity, storage = defaultStorage()) {
  const ref = String(endpointRef || "").trim();
  const value = String(identity || "").trim();
  if (!ref || !value) {
    return false;
  }
  try {
    const pins = readPins(storage);
    pins[ref] = value;
    storage.setItem(ELEVATION_PINS_STORAGE_KEY, JSON.stringify(pins));
    return true;
  } catch {
    return false;
  }
}

// forgetElevationIdentity drops the pin for endpointRef, so the next request asks again. It reports
// whether there was one.
function forgetElevationIdentity(endpointRef, storage = defaultStorage()) {
  const ref = String(endpointRef || "").trim();
  if (!ref) {
    return false;
  }
  try {
    const pins = readPins(storage);
    if (!(ref in pins)) {
      return false;
    }
    delete pins[ref];
    storage.setItem(ELEVATION_PINS_STORAGE_KEY, JSON.stringify(pins));
    return true;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

// elevationPinNeedsConfirm reports whether the first key of endpointRef must be confirmed by the
// person before it is pinned. Like chat, a runtime on this machine is pinned silently: the Console's
// own runtime, reached from the desktop app or a page on a loopback address. Any other is confirmed
// against the fingerprint mistermorph console logs at start.
function elevationPinNeedsConfirm(endpointRef, { localEndpointRef = "", desktop = false, hostname = "" } = {}) {
  const ref = String(endpointRef || "").trim();
  if (!ref || ref !== String(localEndpointRef || "").trim()) {
    return true;
  }
  return !(desktop || isLoopbackHostname(hostname));
}

export {
  ELEVATION_PINS_STORAGE_KEY,
  elevationPinNeedsConfirm,
  forgetElevationIdentity,
  pinElevationIdentity,
  pinnedElevationIdentity,
};
