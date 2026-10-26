// The browser's side of an elevated command's approval: it checks the runtime's signed offer and
// encrypts the sudo password for it, end to end (docs/feat/feat_20261026_elevation_client_approval.md
// §3.4). It matches internal/elevate/seal byte for byte. It does not use crypto.subtle, which plain
// HTTP pages do not have.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const VERSION = 1;
const LABEL = "mistermorph-elevation-v1";
const NONCE_SIZE = 24;
const encoder = new TextEncoder();

class ElevationSealError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ElevationSealError";
    // "identity_changed" or "bad_offer".
    this.code = code;
  }
}

function badOffer(detail) {
  return new ElevationSealError("bad_offer", `the approval request is not signed by the runtime${detail ? `: ${detail}` : ""}`);
}

// base64url without padding, as Go's base64.RawURLEncoding.
function encodeBase64URL(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// decodeBase64URL returns null for anything RawURLEncoding would not take.
function decodeBase64URL(text) {
  const value = String(text ?? "").trim();
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    return null;
  }
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hexBytes(hex) {
  const value = String(hex || "");
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// The request a signature, key and ciphertext are bound to: { elevationID, taskID, command, cwd,
// deadline } with deadline in Unix seconds.
function normalizeBinding(binding) {
  return {
    elevationID: String(binding?.elevationID || ""),
    taskID: String(binding?.taskID || ""),
    command: String(binding?.command || ""),
    cwd: String(binding?.cwd || ""),
    deadline: Math.trunc(Number(binding?.deadline) || 0),
  };
}

// context is label ‖ purpose ‖ elevation ID ‖ task ID (each with its 4-byte length) ‖ SHA-256 of
// the command ‖ SHA-256 of the directory ‖ the deadline (Unix seconds, 8 bytes) ‖ x.
function bindingContext(binding, purpose, x = new Uint8Array(0)) {
  const b = normalizeBinding(binding);
  const parts = [encoder.encode(LABEL)];
  for (const field of [purpose, b.elevationID, b.taskID]) {
    const bytes = encoder.encode(field);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length, false);
    parts.push(length, bytes);
  }
  parts.push(sha256(encoder.encode(b.command)), sha256(encoder.encode(b.cwd)));
  const deadline = new Uint8Array(8);
  new DataView(deadline.buffer).setBigUint64(0, BigInt(b.deadline), false);
  parts.push(deadline, x);
  return concatBytes(...parts);
}

// The identity key's fingerprint, as `mistermorph console` logs it: the first 16 bytes of its
// SHA-256, as 8 groups of 4 hex digits.
function elevationFingerprint(identity) {
  const pub = typeof identity === "string" ? decodeBase64URL(identity) : identity;
  if (!(pub instanceof Uint8Array) || pub.length !== 32) {
    return "";
  }
  const digits = Array.from(sha256(pub).subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return digits.match(/.{4}/g).join(" ");
}

// verifyElevationOffer checks offer for binding against pinned (the base64url identity the client
// trusts, or "" to take the one the offer names) and returns the runtime's X25519 key and identity.
function verifyElevationOffer(binding, offer, pinned = "") {
  if (offer?.v !== VERSION) {
    throw badOffer(`version ${offer?.v}`);
  }
  const identity = decodeBase64URL(offer.identity);
  if (!identity || identity.length !== 32) {
    throw badOffer("bad identity key");
  }
  const pinnedText = String(pinned || "").trim();
  if (pinnedText) {
    const pinnedKey = decodeBase64URL(pinnedText);
    if (!pinnedKey || encodeBase64URL(pinnedKey) !== encodeBase64URL(identity)) {
      throw new ElevationSealError("identity_changed", "the runtime's identity key changed");
    }
  }
  const serverPub = decodeBase64URL(offer.server_pub);
  const signature = decodeBase64URL(offer.signature);
  if (!serverPub || !signature || serverPub.length !== 32 || signature.length !== 64) {
    throw badOffer("");
  }
  let valid = false;
  try {
    valid = ed25519.verify(signature, bindingContext(binding, "offer", serverPub), identity, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) {
    throw badOffer("");
  }
  return { serverPub, identity: encodeBase64URL(identity) };
}

function randomBytes(size) {
  const out = new Uint8Array(size);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// sealElevationPassword checks offer (see verifyElevationOffer) and encrypts password for it. It
// returns { client_pub, nonce, ciphertext } for the answer. A password given as bytes is zeroed
// here. Tests pass options.clientPrivate and options.nonce to make the result fixed.
function sealElevationPassword(binding, offer, pinned, password, options = {}) {
  const plain = password instanceof Uint8Array ? password : encoder.encode(String(password ?? ""));
  const clientPrivate = options.clientPrivate ? Uint8Array.from(options.clientPrivate) : randomBytes(32);
  let shared = null;
  let key = null;
  try {
    const { serverPub } = verifyElevationOffer(binding, offer, pinned);
    const nonce = options.nonce ? Uint8Array.from(options.nonce) : randomBytes(NONCE_SIZE);
    if (nonce.length !== NONCE_SIZE) {
      throw new Error("nonce must be 24 bytes");
    }
    const clientPub = x25519.getPublicKey(clientPrivate);
    try {
      shared = x25519.getSharedSecret(clientPrivate, serverPub);
    } catch {
      throw badOffer("bad key");
    }
    key = hkdf(sha256, shared, concatBytes(serverPub, clientPub), bindingContext(binding, "key"), 32);
    const ciphertext = xchacha20poly1305(key, nonce, bindingContext(binding, "answer", clientPub)).encrypt(plain);
    return {
      client_pub: encodeBase64URL(clientPub),
      nonce: encodeBase64URL(nonce),
      ciphertext: encodeBase64URL(ciphertext),
    };
  } finally {
    plain.fill(0);
    clientPrivate.fill(0);
    shared?.fill(0);
    key?.fill(0);
  }
}

export {
  ElevationSealError,
  bindingContext,
  decodeBase64URL,
  elevationFingerprint,
  encodeBase64URL,
  hexBytes,
  sealElevationPassword,
  verifyElevationOffer,
};
