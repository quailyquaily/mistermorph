// The selected agent's name and avatar for the frame (the Vue console's usePersonaSummary): loads
// them when a switcher (or the tab's icon, AgentFavicon) mounts and when the selected endpoint
// changes, and again when setup or the persona settings say the identity or the avatar changed.
import { cleanup, effect, untracked } from "nsh";
import { endpointState } from "../../lib/core/context.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "../../lib/core/endpoints.js";
import {
  onPersonaEvent,
  PERSONA_AVATAR_UPDATED_EVENT,
  PERSONA_IDENTITY_UPDATED_EVENT,
} from "../../lib/core/persona-profile.js";
import { usePersonaStore } from "../../lib/stores/personaStore.js";

/** The endpoint the summary is for: the selected one, else the console's own. */
export function selectedPersonaEndpointRef() {
  return String(endpointState.selectedRef || "").trim() || CONSOLE_LOCAL_ENDPOINT_REF;
}

// The setup and persona-settings events are heard once however many parts of the frame show the
// summary (the sidebar or the phone's bar, and the tab's icon: AgentFavicon), so a change loads the
// identity or the avatar once.
let eventUsers = 0;
let stopEvents: (() => void) | null = null;

function hearPersonaEvents(persona: ReturnType<typeof usePersonaStore>) {
  eventUsers += 1;
  if (eventUsers === 1) {
    const stopIdentity = onPersonaEvent(PERSONA_IDENTITY_UPDATED_EVENT, () => {
      void persona
        .loadIdentity({ endpointRef: selectedPersonaEndpointRef(), force: true, perfSource: "shared-preload" })
        .catch((error: Error) => console.warn("persona identity:", error?.message || error));
    });
    const stopAvatar = onPersonaEvent(PERSONA_AVATAR_UPDATED_EVENT, () => {
      void persona
        .loadAvatar({ endpointRef: selectedPersonaEndpointRef(), force: true, perfSource: "shared-preload" })
        .catch((error: Error) => console.warn("persona avatar:", error?.message || error));
    });
    stopEvents = () => {
      stopIdentity();
      stopAvatar();
    };
  }
  cleanup(() => {
    eventUsers -= 1;
    if (eventUsers === 0) {
      stopEvents?.();
      stopEvents = null;
    }
  });
}

export function usePersonaSummary() {
  const persona = usePersonaStore();

  // Loads already under way (another part of the frame asked first) are shared, not repeated.
  const loadPersonaSummary = (options: { force?: boolean } = {}) =>
    persona
      .loadSummary({
        endpointRef: selectedPersonaEndpointRef(),
        force: options.force === true,
        perfSource: "shared-preload",
      })
      .catch((error: Error) => console.warn("persona summary:", error?.message || error));

  effect(() => {
    void endpointState.selectedRef;
    untracked(() => void loadPersonaSummary());
  });

  hearPersonaEvents(persona);

  return {
    personaAvatarURL: () => String(persona.avatarURL || ""),
    personaName: () => String(persona.name || ""),
    /** The endpoint the store's name and avatar belong to (they follow the selected one). */
    personaEndpointRef: () => String(persona.endpointRef || ""),
    loadPersonaSummary,
  };
}
