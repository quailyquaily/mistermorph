import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decodeBase64URL,
  elevationFingerprint,
  encodeBase64URL,
  hexBytes,
  sealElevationPassword,
  verifyElevationOffer,
} from "./elevation-seal.js";

// The vectors internal/elevate/seal writes and checks, so both sides agree byte for byte.
const vectors = JSON.parse(
  readFileSync(new URL("../../../../internal/elevate/seal/testdata/vectors.json", import.meta.url), "utf8")
);

function vectorBinding(overrides = {}) {
  return {
    elevationID: vectors.binding.elevation_id,
    taskID: vectors.binding.task_id,
    command: vectors.binding.command,
    cwd: vectors.binding.cwd,
    deadline: vectors.binding.deadline,
    ...overrides,
  };
}

test("verifyElevationOffer accepts the runtime's offer, pinned or not", () => {
  const first = verifyElevationOffer(vectorBinding(), vectors.offer, "");
  assert.equal(first.identity, vectors.offer.identity);
  assert.equal(encodeBase64URL(first.serverPub), vectors.offer.server_pub);
  const pinned = verifyElevationOffer(vectorBinding(), vectors.offer, vectors.offer.identity);
  assert.equal(pinned.identity, vectors.offer.identity);
});

test("sealElevationPassword reproduces the Go answer", () => {
  const answer = sealElevationPassword(vectorBinding(), vectors.offer, vectors.offer.identity, vectors.password, {
    clientPrivate: hexBytes(vectors.client_private_hex),
    nonce: hexBytes(vectors.nonce_hex),
  });
  assert.deepEqual(answer, vectors.answer);
});

test("sealElevationPassword zeroes a password given as bytes", () => {
  const password = new TextEncoder().encode(vectors.password);
  const answer = sealElevationPassword(vectorBinding(), vectors.offer, "", password, {
    clientPrivate: hexBytes(vectors.client_private_hex),
    nonce: hexBytes(vectors.nonce_hex),
  });
  assert.equal(answer.ciphertext, vectors.answer.ciphertext);
  assert.ok(password.every((byte) => byte === 0));
});

test("sealElevationPassword makes a fresh key and nonce each time", () => {
  const a = sealElevationPassword(vectorBinding(), vectors.offer, "", "pw");
  const b = sealElevationPassword(vectorBinding(), vectors.offer, "", "pw");
  assert.notEqual(a.client_pub, b.client_pub);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(decodeBase64URL(a.nonce).length, 24);
});

test("elevationFingerprint matches the runtime's", () => {
  assert.equal(elevationFingerprint(vectors.offer.identity), vectors.fingerprint);
  assert.equal(elevationFingerprint("not a key"), "");
});

test("verifyElevationOffer refuses an offer for another request or runtime", () => {
  const cases = [
    { name: "command", binding: vectorBinding({ command: "apt-get install -y curl" }) },
    { name: "cwd", binding: vectorBinding({ cwd: "/" }) },
    { name: "deadline", binding: vectorBinding({ deadline: vectors.binding.deadline + 1 }) },
    { name: "elevation id", binding: vectorBinding({ elevationID: "el_other" }) },
    { name: "task id", binding: vectorBinding({ taskID: "task_02" }) },
  ];
  for (const { name, binding } of cases) {
    assert.throws(() => verifyElevationOffer(binding, vectors.offer, ""), { code: "bad_offer" }, name);
    assert.throws(
      () => sealElevationPassword(binding, vectors.offer, "", "pw"),
      { code: "bad_offer" },
      `seal ${name}`
    );
  }
});

test("verifyElevationOffer refuses a changed identity or a malformed offer", () => {
  const other = encodeBase64URL(new Uint8Array(32).fill(9));
  assert.throws(() => verifyElevationOffer(vectorBinding(), vectors.offer, other), { code: "identity_changed" });
  assert.throws(() => sealElevationPassword(vectorBinding(), vectors.offer, other, "pw"), { code: "identity_changed" });
  const malformed = [
    { ...vectors.offer, v: 2 },
    { ...vectors.offer, identity: "AAAA" },
    { ...vectors.offer, server_pub: encodeBase64URL(new Uint8Array(32).fill(1)) },
    { ...vectors.offer, signature: vectors.offer.signature.slice(0, -2) + "AA" },
    { ...vectors.offer, signature: "!!" },
  ];
  for (const offer of malformed) {
    assert.throws(() => verifyElevationOffer(vectorBinding(), offer, ""), { code: "bad_offer" });
  }
});
