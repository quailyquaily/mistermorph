// A line across the top of the window while what the person sends (a sudo password on an approval
// card, the Console password) crosses the network unencrypted (the Vue console's
// AppInsecureBanner). It says which hop: the page itself, or the Console's hop to the selected
// endpoint or the endpoint its chat submits to. The runtime does not check, so this is the only
// warning: closing it lasts until the page reloads, and it comes back when a different hop turns
// unencrypted. It shows the short message, with the full one (naming the SSH tunnel and VPN
// exceptions) as its tooltip; on a phone it drops the label too.
import { computed, signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { endpointState, runtimeEndpointByRef, translate } from "../../lib/core/context.js";
import { isDesktopRuntime } from "../../lib/core/desktop-runtime.js";
import { insecureHops } from "../../lib/core/endpoints.js";
import { origin, secureContext } from "../../lib/platform";
import { isMobile } from "../../lib/shell";
import { Button } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

// What the person closed, by which hops were unencrypted, for as long as the app runs: kept outside
// the component, so it stays closed when the frame swaps (login page to workspace).
const dismissedKey = signal("");

/**
 * Whether the page is a secure context, as a browser decides it: HTTPS, or plain HTTP to this
 * machine (localhost, 127.0.0.0/8, ::1), which an SSH tunnel is. The host does not report
 * `window.isSecureContext`, so it is worked out from the page's origin.
 */
export function pageIsSecureContext(pageOrigin: string) {
  let parsed: URL;
  try {
    parsed = new URL(String(pageOrigin || "").trim());
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:") return true;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

export function InsecureBanner() {
  const hops = computed(() => {
    const selected = runtimeEndpointByRef(endpointState.selectedRef);
    const submit = runtimeEndpointByRef(String(selected?.submit_endpoint_ref || ""));
    return (insecureHops as (options: Record<string, unknown>) => { page: boolean; endpoint: string })({
      desktop: isDesktopRuntime(),
      secureContext: secureContext() ?? pageIsSecureContext(origin()),
      endpointURLs: [selected?.url, submit?.url],
    });
  });
  const kind = () => {
    const { page, endpoint } = hops();
    if (page && endpoint) return "both";
    if (page) return "page";
    return endpoint ? "endpoint" : "";
  };
  const key = () => (kind() ? `${kind()}|${hops().endpoint}` : "");
  const visible = () => key() !== "" && key() !== dismissedKey();
  const text = () => t(`connection_insecure_${kind()}`, { host: hops().endpoint });
  const shortText = () => t(`connection_insecure_${kind()}_short`, { host: hops().endpoint });

  return (
    <If when={visible()}>
      <View
        role="alert"
        testID="insecure-banner"
        class="flex-row items-center gap-2 border-b border-warn bg-card px-3 py-1"
      >
        <If when={!isMobile()}>
          <Text class="font-mono text-xs uppercase tracking-wide text-warn-dark">
            {`[${t("connection_insecure_label")}]`}
          </Text>
        </If>
        <View class="size-1.5 bg-warn" accessibilityElementsHidden />
        <View
          class="flex-1"
          tooltip={
            <Tooltip class="max-w-96 bg-foreground px-2 py-1">
              <Text class="text-xs text-background">{text()}</Text>
            </Tooltip>
          }
          accessibilityLabel={text()}
        >
          <Text class="text-xs text-foreground line-clamp-1">{shortText()}</Text>
        </View>
        <Button
          variant="plain"
          size="xxs"
          iconOnly
          icon="PhX"
          title={t("action_close")}
          testID="insecure-banner-close"
          onPress={() => dismissedKey.set(key())}
        />
      </View>
    </If>
  );
}
