// The browser tab's icon (web only): the selected agent's avatar, as the agent switcher shows it
// (the persona's avatar, else the endpoint's), or the app icon when it has none. The page draws it
// (host.js, morph.favicon) and keeps the app icon while an avatar loads or when one fails; this
// part says which image and when. Mounted once by the frame (Shell), on every page but the
// shellless ones (login, troubleshooting), which show the app icon.
import { cleanup, computed, effect, untracked } from "nsh";
import { setFavicon } from "../../lib/platform";
import { selectedEndpointItem } from "../../lib/shell";
import { selectedPersonaEndpointRef, usePersonaSummary } from "./personaSummary";

/**
 * The image the tab shows, "" for the app icon: the persona's avatar while the store holds the
 * selected endpoint's (not the one switched away from), else the endpoint's own `avatar_url`.
 */
export function agentFaviconURL(input: {
  personaURL: string;
  personaEndpointRef: string;
  selectedRef: string;
  endpointAvatarURL: string;
}): string {
  const persona = String(input.personaURL || "").trim();
  if (persona && input.personaEndpointRef === input.selectedRef) return persona;
  return String(input.endpointAvatarURL || "").trim();
}

/** The selected endpoint's own avatar URL, "" when it has none (the switcher then shows the logo). */
function endpointAvatarURL() {
  const image = selectedEndpointItem()?.image;
  // The logo stands in as an asset, not a URL.
  return typeof image === "string" ? image : "";
}

export function AgentFavicon() {
  const { personaAvatarURL, personaEndpointRef } = usePersonaSummary();
  const url = computed(() =>
    agentFaviconURL({
      personaURL: personaAvatarURL(),
      personaEndpointRef: personaEndpointRef(),
      selectedRef: selectedPersonaEndpointRef(),
      endpointAvatarURL: endpointAvatarURL(),
    }),
  );
  let sent: string | null = null;
  effect(() => {
    const next = url();
    if (next === sent) return;
    sent = next;
    untracked(() => setFavicon(next));
  });
  cleanup(() => setFavicon(""));
  return null;
}
