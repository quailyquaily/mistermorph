// node --test scripts/testflight-submit.test.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { apiToken, buildNumber, client, defaultWhatToTest, submit } from "./testflight-submit.mjs";

test("build numbers match build-ios.sh's", () => {
  assert.equal(buildNumber("0.3.80"), "3080");
  assert.equal(buildNumber("v0.3.133"), "3133");
  assert.equal(buildNumber("1.2.3-rc1"), "1002003");
  assert.throws(() => buildNumber("main"));
});

test("what to test links the release", () => {
  assert.equal(
    defaultWhatToTest("v0.3.133", "owner/repo"),
    "Morph v0.3.133. What changed: https://github.com/owner/repo/releases/tag/v0.3.133",
  );
  assert.equal(defaultWhatToTest("0.3.133", ""), "Morph v0.3.133.");
});

test("the token is an ES256 JWT Apple can verify", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const token = apiToken({ keyPem, keyId: "KEY1234567", issuerId: "issuer-uuid", now: 1_700_000_000_000 });
  const [head, body, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.iss, "issuer-uuid");
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.ok(claims.exp - claims.iat <= 20 * 60, "Apple refuses tokens longer than 20 minutes");
  const ok = verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"));
  assert.ok(ok);
});

// A fake App Store Connect: answers by method and path, records each call.
function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://api.appstoreconnect.apple.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, auth: init.headers.Authorization });
    const route = routes.find((r) => r.method === init.method && r.match(path));
    if (!route) return new Response(JSON.stringify({ errors: [{ detail: "no route" }] }), { status: 404 });
    const [status, payload] = route.reply(path, body);
    return new Response(payload ? JSON.stringify(payload) : null, { status });
  };
  return { calls, api: client({ token: () => "token", fetchImpl }) };
}

function routesFor({ states, localization = null, encryption = false, submitStatus = 201, groups }) {
  let poll = 0;
  return [
    {
      method: "GET",
      match: (p) => p.startsWith("/v1/builds?"),
      reply: () => {
        const state = states[Math.min(poll++, states.length - 1)];
        if (state === null) return [200, { data: [] }];
        return [200, { data: [{ id: "build-1", attributes: { processingState: state, usesNonExemptEncryption: encryption } }] }];
      },
    },
    { method: "PATCH", match: (p) => p === "/v1/builds/build-1", reply: () => [200, {}] },
    {
      method: "GET",
      match: (p) => p === "/v1/builds/build-1/betaBuildLocalizations",
      reply: () => [200, { data: localization ? [localization] : [] }],
    },
    { method: "POST", match: (p) => p === "/v1/betaBuildLocalizations", reply: () => [201, {}] },
    { method: "PATCH", match: (p) => p.startsWith("/v1/betaBuildLocalizations/"), reply: () => [200, {}] },
    {
      method: "GET",
      match: (p) => p.startsWith("/v1/betaGroups?"),
      reply: () => [200, {
        data: groups ?? [
          { id: "group-internal", attributes: { name: "Beta", isInternalGroup: true } },
          { id: "group-beta", attributes: { name: "Beta", isInternalGroup: false } },
        ],
      }],
    },
    {
      method: "POST",
      match: (p) => p === "/v1/betaAppReviewSubmissions",
      reply: () => submitStatus === 201
        ? [201, {}]
        : [submitStatus, { errors: [{ detail: "Another build is in review." }] }],
    },
    { method: "POST", match: (p) => p === "/v1/betaGroups/group-beta/relationships/builds", reply: () => [204, null] },
  ];
}

const options = (extra = {}) => ({
  appId: "6739012345",
  version: "v0.3.133",
  group: "Beta",
  whatToTest: "Morph v0.3.133.",
  intervalMs: 1,
  timeoutMs: 1000,
  sleep: async () => {},
  log: () => {},
  warn: () => {},
  ...extra,
});

test("waits for processing, then fills in what to test, submits and adds the build to the group", async () => {
  const { calls, api } = fakeApi(routesFor({ states: [null, "PROCESSING", "VALID"] }));
  const result = await submit(api, options());
  assert.deepEqual(result, { buildId: "build-1", submitted: true });

  const lookup = new URL(`https://x${calls[0].path}`).searchParams;
  assert.equal(lookup.get("filter[app]"), "6739012345");
  assert.equal(lookup.get("filter[version]"), "3133");
  assert.equal(lookup.get("filter[preReleaseVersion.version]"), "0.3.133");

  const writes = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(writes, [
    "POST /v1/betaBuildLocalizations",
    "POST /v1/betaAppReviewSubmissions",
    "POST /v1/betaGroups/group-beta/relationships/builds",
  ]);
  const localization = calls.find((c) => c.path === "/v1/betaBuildLocalizations").body.data;
  assert.deepEqual(localization.attributes, { locale: "en-US", whatsNew: "Morph v0.3.133." });
  assert.deepEqual(localization.relationships.build.data, { type: "builds", id: "build-1" });
  assert.ok(calls.every((c) => c.auth === "Bearer token"));
});

test("updates an existing English localization and answers a missing encryption question", async () => {
  const { calls, api } = fakeApi(routesFor({
    states: ["VALID"],
    encryption: null,
    localization: { id: "loc-1", attributes: { locale: "en-US", whatsNew: "" } },
  }));
  await submit(api, options());
  const writes = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(writes.slice(0, 2), ["PATCH /v1/builds/build-1", "PATCH /v1/betaBuildLocalizations/loc-1"]);
  assert.equal(calls[1].body.data.attributes.usesNonExemptEncryption, false);
});

test("a refused submission warns, still adds the build to the group, and does not fail", async () => {
  const warnings = [];
  const { calls, api } = fakeApi(routesFor({ states: ["VALID"], submitStatus: 409 }));
  const result = await submit(api, options({ warn: (m) => warnings.push(m) }));
  assert.equal(result.submitted, false);
  assert.match(warnings[0], /Another build is in review/);
  assert.ok(calls.some((c) => c.path === "/v1/betaGroups/group-beta/relationships/builds"));
});

test("a server error on submission fails the step", async () => {
  const { api } = fakeApi(routesFor({ states: ["VALID"], submitStatus: 500 }));
  await assert.rejects(submit(api, options()), /HTTP 500/);
});

test("fails with what to do when there is no external group of that name", async () => {
  const { calls, api } = fakeApi(routesFor({
    states: ["VALID"],
    groups: [{ id: "group-internal", attributes: { name: "Beta", isInternalGroup: true } }],
  }));
  await assert.rejects(submit(api, options()), /no external TestFlight group named "Beta"/);
  assert.ok(!calls.some((c) => c.path === "/v1/betaAppReviewSubmissions"), "nothing submitted without a group");
});

test("fails when processing fails or takes too long", async () => {
  await assert.rejects(submit(fakeApi(routesFor({ states: ["INVALID"] })).api, options()), /could not process/);
  await assert.rejects(
    submit(fakeApi(routesFor({ states: ["PROCESSING"] })).api, options({ intervalMs: 600, timeoutMs: 1000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })),
    /still PROCESSING/,
  );
});
