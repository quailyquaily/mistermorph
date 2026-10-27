const CONSOLE_LOCAL_ENDPOINT_REF = "ep_console_local";

function normalizeEndpointRef(ref) {
  return typeof ref === "string" ? ref.trim() : "";
}

function normalizeEndpointMode(mode) {
  return String(mode || "").trim().toLowerCase();
}

function isConsoleLocalEndpoint(item) {
  return normalizeEndpointRef(item?.endpoint_ref) === CONSOLE_LOCAL_ENDPOINT_REF;
}

function isEndpointSelectable(item) {
  return Boolean(
    normalizeEndpointRef(item?.endpoint_ref) &&
      (item?.connected === true || item?.health_pending === true),
  );
}

function visibleEndpoints(items, options = {}) {
  const connectedOnly = Boolean(options.connectedOnly);
  const rows = Array.isArray(items)
    ? items.filter((item) => normalizeEndpointRef(item?.endpoint_ref))
    : [];
  let visibleRows = rows;
  if (connectedOnly) {
    visibleRows = visibleRows.filter((item) => Boolean(item?.connected));
  }
  return visibleRows;
}

function rootEntryEndpoint(items) {
  const endpoints = visibleEndpoints(items);
  if (endpoints.length !== 1) {
    return null;
  }
  const [endpoint] = endpoints;
  if (!isEndpointSelectable(endpoint)) {
    return null;
  }
  return endpoint;
}

function endpointChannelLabel(mode, t) {
  switch (normalizeEndpointMode(mode)) {
    case "console":
      return t("endpoint_channel_console");
    case "serve":
      return t("endpoint_channel_serve");
    case "integration":
      return t("endpoint_channel_integration");
    case "telegram":
      return t("endpoint_channel_telegram");
    case "slack":
      return t("endpoint_channel_slack");
    case "line":
      return t("endpoint_channel_line");
    case "lark":
      return t("endpoint_channel_lark");
	case "mixin":
	  return t("endpoint_channel_mixin");
    case "discord":
      return t("endpoint_channel_discord");
    case "wechat":
      return t("endpoint_channel_wechat");
    case "whatsapp":
      return t("endpoint_channel_whatsapp");
    case "bluesky":
      return t("endpoint_channel_bluesky");
    case "x":
      return t("endpoint_channel_x");
    default:
      return String(mode || "").trim() || t("chat_readonly_unknown_channel");
  }
}

function endpointChannelTone(mode) {
  switch (normalizeEndpointMode(mode)) {
    case "console":
      return "console";
    case "serve":
      return "serve";
    case "integration":
      return "integration";
    case "telegram":
      return "telegram";
    case "slack":
      return "slack";
    case "line":
      return "line";
    case "lark":
      return "lark";
	case "mixin":
	  return "mixin";
    case "discord":
      return "discord";
    case "wechat":
      return "wechat";
    case "whatsapp":
      return "whatsapp";
    case "bluesky":
      return "bluesky";
    case "x":
      return "x";
    default:
      return "default";
  }
}

function endpointChannelBadges(item, t) {
  return [
    {
      label: endpointChannelLabel(item?.mode, t),
      tone: endpointChannelTone(item?.mode),
    },
  ];
}

function endpointLocationLabel(item, t) {
  const raw = String(item?.url || "").trim();
  return raw || t("endpoint_location_local");
}

function endpointCompactLocationLabel(item, t) {
  const raw = String(item?.url || "").trim();
  if (!raw) {
    return t("endpoint_location_local");
  }
  try {
    const parsed = new URL(raw);
    return parsed.host || raw;
  } catch {
    return raw;
  }
}

// endpointURLInsecure reports whether the Console reaches an endpoint over plain HTTP to another
// machine, where what it forwards, such as a sudo password, crosses the network unencrypted.
// HTTPS, loopback and the in-process local runtime are fine.
function endpointURLInsecure(rawURL) {
  let parsed;
  try {
    parsed = new URL(String(rawURL || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host);
  return !loopback;
}

// connectionInsecure reports whether what the person sends, such as a password, crosses the network
// unencrypted on either hop: the page itself on plain HTTP (a secure context covers HTTPS and
// localhost, so an SSH tunnel; the desktop app talks to its own runtime), or the Console reaching
// an endpoint over plain HTTP to another machine. Only the browser can tell: behind a TLS proxy or a
// VPN the runtime sees plain HTTP either way. A VPN cannot be told apart here either.
function connectionInsecure({ desktop = false, secureContext = true, endpointURLs = [] } = {}) {
  if (!desktop && secureContext === false) {
    return true;
  }
  return endpointURLs.some((url) => endpointURLInsecure(url));
}

function endpointDisplayItem(item, t) {
  const channelBadges = endpointChannelBadges(item, t);
  const channelLabel = channelBadges.map((item) => item.label).join(" + ");
  const compactLocation = endpointCompactLocationLabel(item, t);
  let title = String(item?.name || "").trim();
  if (!title) {
    title = isConsoleLocalEndpoint(item) ? channelLabel : compactLocation || channelLabel;
  }
  return {
    value: normalizeEndpointRef(item?.endpoint_ref),
    endpoint_ref: normalizeEndpointRef(item?.endpoint_ref),
    title,
    subtitle: `${channelLabel} · ${compactLocation}`,
    meta: compactLocation,
    location: endpointLocationLabel(item, t),
    channelLabel,
    channelTone: channelBadges[0]?.tone || endpointChannelTone(item?.mode),
    channelBadges,
    connected: Boolean(item?.connected),
  };
}

export {
  CONSOLE_LOCAL_ENDPOINT_REF,
  connectionInsecure,
  endpointChannelLabel,
  endpointDisplayItem,
  endpointURLInsecure,
  isConsoleLocalEndpoint,
  isEndpointSelectable,
  rootEntryEndpoint,
  visibleEndpoints,
};
