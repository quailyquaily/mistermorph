// A job's ID, as the runtime makes it (cron.NewJobID): "job-" and a random (version 4) UUID in
// lower case. The ID names the job alone, whatever starts its runs. IDs an earlier version made
// ("cron-<uuid>", "task-<n>", or one a person chose) stay valid as they are.

export const JOB_ID_PREFIX = "job-";

const JOB_ID_PATTERN = /^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function randomBytes(count, random) {
  const bytes = new Uint8Array(count);
  if (random) {
    random(bytes);
    return bytes;
  }
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < count; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

// uuidV4 is a random UUID (RFC 9562 version 4) in lower case. random, for tests, fills a byte
// array; without it the platform's crypto is used, or Math.random where there is none.
export function uuidV4(random) {
  const bytes = randomBytes(16, random);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// newJobID is a new job's ID: "job-<uuid v4>".
export function newJobID(random) {
  return JOB_ID_PREFIX + uuidV4(random);
}

// isGeneratedJobID reports whether id has the form newJobID (and the runtime) make.
export function isGeneratedJobID(id) {
  return JOB_ID_PATTERN.test(String(id || "").trim());
}
