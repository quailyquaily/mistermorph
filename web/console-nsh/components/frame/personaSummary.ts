// The selected agent's name and avatar for the frame (the Vue console's usePersonaSummary): loads
// them when a switcher mounts and when the selected endpoint changes, and again when setup or the
// persona settings say the identity or the avatar changed.
import { cleanup, effect, untracked } from "nsh";
import { endpointState } from "../../lib/core/context.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "../../lib/core/endpoints.js";
import {
  onPersonaEvent,
  PERSONA_AVATAR_UPDATED_EVENT,
  PERSONA_IDENTITY_UPDATED_EVENT,
} from "../../lib/core/persona-profile.js";
import { usePersonaStore } from "../../lib/stores/personaStore.js";

function selectedPersonaEndpointRef() {
  return String(endpointState.selectedRef || "").trim() || CONSOLE_LOCAL_ENDPOINT_REF;
}

export function usePersonaSummary() {
  const persona = usePersonaStore();

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
  cleanup(() => {
    stopIdentity();
    stopAvatar();
  });

  return {
    personaAvatarURL: () => String(persona.avatarURL || ""),
    personaName: () => String(persona.name || ""),
    loadPersonaSummary,
  };
}
