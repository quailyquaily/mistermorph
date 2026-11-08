// Files in the chat: uploads of the composer's attachments, downloads that the host saves, and
// previews fetched with the session's token. The Vue console built blobs and <a download> links;
// here the bytes of a picked file stay in the host (uploadFile) and a download is a URL the host
// fetches with the same headers (saveFile).
import { API_BASE, apiFetchBlob, authState, runtimeApiDownloadForEndpoint } from "../../lib/core/context.js";
import { saveFile, uploadFile, type PickedFile } from "../../lib/platform";

function authHeaders(): Record<string, string> {
  return authState.token ? { Authorization: `Bearer ${authState.token}` } : {};
}

/** The console URL of an agent's route through /api/proxy (or /api/proxy/download). */
export function proxyURL(endpointRef: string, uri: string, download = false) {
  const query = new URLSearchParams();
  query.set("endpoint", String(endpointRef || "").trim());
  query.set("uri", uri.startsWith("/") ? uri : `/${uri}`);
  return `${API_BASE}/proxy${download ? "/download" : ""}?${query.toString()}`;
}

/** An error the way apiFetch makes them: the server's `error`, else the status. */
function uploadError(status: number, statusText: string, body: string) {
  let message = "";
  try {
    message = String(JSON.parse(body)?.error || "");
  } catch {
    message = body.trim();
  }
  const err = new Error(message || statusText || `HTTP ${status}`) as Error & { status?: number };
  err.status = status;
  return err;
}

/** Uploads one picked file to the agent's /files/upload, as the Vue console's FormData did. */
export async function uploadPickedFile(endpointRef: string, file: PickedFile, fields: Record<string, string>) {
  const result = await uploadFile(file, {
    url: proxyURL(endpointRef, "/files/upload"),
    method: "POST",
    headers: authHeaders(),
    field: "files",
    fields,
  });
  if (!result.ok) {
    throw uploadError(result.status, result.statusText, result.body);
  }
  try {
    return JSON.parse(result.body || "{}");
  } catch {
    return {};
  }
}

/** Transcribes a voice recording with the agent's transcription model (POST /voice/transcribe). */
export async function transcribeRecording(endpointRef: string, file: PickedFile): Promise<string> {
  const result = await uploadFile(file, {
    url: proxyURL(endpointRef, "/voice/transcribe"),
    method: "POST",
    headers: authHeaders(),
    field: "audio",
  });
  if (!result.ok) {
    throw uploadError(result.status, result.statusText, result.body);
  }
  try {
    return String(JSON.parse(result.body || "{}")?.text || "").trim();
  } catch {
    return "";
  }
}

/** Saves what the agent serves at `uri` (through /api/proxy/download) as `name`. */
export async function saveEndpointFile(endpointRef: string, uri: string, name: string) {
  return saveFile({ name: String(name || "").trim() || "download", url: proxyURL(endpointRef, uri, true), headers: authHeaders() });
}

/** Saves what the console serves at `pathname` (below /api) as `name`. */
export async function saveConsoleFile(pathname: string, name: string) {
  return saveFile({ name: String(name || "").trim() || "download", url: `${API_BASE}${pathname}`, headers: authHeaders() });
}

/** A blob of the agent's file, for a preview. */
export async function fetchEndpointBlob(endpointRef: string, uri: string): Promise<Blob> {
  return (await runtimeApiDownloadForEndpoint(endpointRef, uri)) as Blob;
}

/** A blob the console serves (`/attachments?...`), for a preview. */
export async function fetchConsoleBlob(pathname: string): Promise<Blob> {
  return (await apiFetchBlob(pathname)) as Blob;
}
