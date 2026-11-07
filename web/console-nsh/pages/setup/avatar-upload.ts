// Sends the persona avatar the setup's image field picked to the endpoint's runtime, through the
// console's proxy (PUT /api/proxy?endpoint=…&uri=/persona/avatar), with the session's token.
//
// The runtime takes WebP only. The picked file's bytes stay in the host, which crops, scales and
// re-encodes it as the image field's adjustment says (`uploadAdjustedImage`), as the Vue console
// did in a canvas.
import { uploadAdjustedImage, type AdjustedImage } from "../../components/settings/ImageUploadField";
import { API_BASE, authState } from "../../lib/core/context.js";
import { PERSONA_AVATAR_ENDPOINT } from "../../lib/core/persona-profile.js";

export async function uploadPersonaAvatar(endpointRef: string, image: AdjustedImage) {
  const query = new URLSearchParams({ endpoint: endpointRef, uri: PERSONA_AVATAR_ENDPOINT });
  const headers: Record<string, string> = { "Content-Type": image.type || "image/webp" };
  if (authState.token) headers.Authorization = `Bearer ${authState.token}`;
  const result = await uploadAdjustedImage(image, { url: `${API_BASE}/proxy?${query.toString()}`, method: "PUT", headers });
  if (!result.ok) {
    let message = `HTTP ${result.status}`;
    try {
      const parsed = JSON.parse(result.body || "{}");
      if (parsed?.error) message = String(parsed.error);
    } catch {
      if (result.body) message = result.body;
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = result.status;
    throw error;
  }
}
