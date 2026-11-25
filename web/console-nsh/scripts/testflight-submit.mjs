#!/usr/bin/env node
// Sends the build that build_ios.yml just uploaded to external TestFlight testers: waits until App
// Store Connect has processed it, fills in "What to Test", submits it to Beta App Review and adds it
// to the external group, which gets it once the review passes.
//
//   VERSION=0.3.80 node scripts/testflight-submit.mjs
//
// Reads APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID (an App Manager key: a
// Developer key can upload but not submit), IOS_APP_STORE_APP_ID, and optionally
// TESTFLIGHT_GROUP (default "Beta") and WHAT_TO_TEST (default: a link to the release's notes).
//
// The sign-in details for the reviewer are not set here: App Store Connect keeps them per app
// (TestFlight → Test Information), and each submission uses them (docs/ios_release.md, Part 9).
//
// A refused submission is a warning, not a failure: with a release or two a day, the previous
// build is often still in review, and the next tag submits again.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";

// The build number build-ios.sh gives a version: major * 1000000 + minor * 1000 + patch.
export function buildNumber(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!match) throw new Error(`not a version: ${JSON.stringify(version)}`);
  return String(Number(match[1]) * 1000000 + Number(match[2]) * 1000 + Number(match[3]));
}

export function shortVersion(version) {
  return /^v?(\d+\.\d+\.\d+)/.exec(String(version).trim())[1];
}

const base64url = (data) => Buffer.from(data).toString("base64url");

// An App Store Connect token: ES256, at most 20 minutes long. A new one for each request, so a long
// wait for processing never outlives it.
export function apiToken({ keyPem, keyId, issuerId, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const head = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const body = base64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 15 * 60, aud: "appstoreconnect-v1" }));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(keyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${base64url(signature)}`;
}

export function defaultWhatToTest(version, repository) {
  const tag = `v${shortVersion(version)}`;
  if (!repository) return `Morph ${tag}.`;
  return `Morph ${tag}. What changed: https://github.com/${repository}/releases/tag/${tag}`;
}

export class ApiError extends Error {
  constructor(method, path, status, body) {
    const details = (body?.errors ?? []).map((e) => e.detail || e.title).filter(Boolean).join("; ");
    super(`${method} ${path}: HTTP ${status}${details ? `: ${details}` : ""}`);
    this.status = status;
  }
}

export function client({ token, fetchImpl = fetch }) {
  return async function api(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiError(method, path, response.status, parsed);
    return parsed;
  };
}

const query = (params) => new URLSearchParams(params).toString();

// Waits for the uploaded build to appear and finish processing (usually 5–30 minutes).
export async function waitForBuild(api, { appId, version, timeoutMs, intervalMs, sleep, log }) {
  const path = `/v1/builds?${query({
    "filter[app]": appId,
    "filter[version]": buildNumber(version),
    "filter[preReleaseVersion.version]": shortVersion(version),
    limit: "1",
  })}`;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const build = (await api("GET", path)).data?.[0];
    const state = build ? build.attributes?.processingState : "not uploaded yet";
    if (state !== last) log(`build ${shortVersion(version)} (${buildNumber(version)}): ${state}`);
    last = state;
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error(`App Store Connect could not process build ${buildNumber(version)} (${state}); Apple emails the reason`);
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`build ${buildNumber(version)} still ${state} after ${Math.round(timeoutMs / 60000)} minutes`);
    }
    await sleep(intervalMs);
  }
}

export async function submit(api, options) {
  const { appId, version, group, whatToTest, log = console.log, warn = console.warn } = options;
  const build = await waitForBuild(api, {
    appId,
    version,
    timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
    intervalMs: options.intervalMs ?? 30 * 1000,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log,
  });
  const buildRef = { type: "builds", id: build.id };

  // nsh.json declares the encryption answer, so this is only for a build made without it: App
  // Store Connect refuses to submit a build with no answer.
  if (build.attributes?.usesNonExemptEncryption == null) {
    await api("PATCH", `/v1/builds/${build.id}`, {
      data: { ...buildRef, attributes: { usesNonExemptEncryption: false } },
    });
    log("export compliance: set to no non-exempt encryption");
  }

  // "What to Test", which external testing requires (at most 4000 characters).
  const notes = whatToTest.slice(0, 4000);
  const localizations = (await api("GET", `/v1/builds/${build.id}/betaBuildLocalizations`)).data ?? [];
  const english = localizations.find((item) => item.attributes?.locale === "en-US");
  if (english) {
    await api("PATCH", `/v1/betaBuildLocalizations/${english.id}`, {
      data: { type: "betaBuildLocalizations", id: english.id, attributes: { whatsNew: notes } },
    });
  } else {
    await api("POST", "/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: "en-US", whatsNew: notes },
        relationships: { build: { data: buildRef } },
      },
    });
  }
  log(`what to test: ${notes}`);

  const groups = (await api("GET", `/v1/betaGroups?${query({ "filter[app]": appId, "filter[name]": group })}`)).data ?? [];
  const external = groups.find((item) => item.attributes?.name === group && item.attributes?.isInternalGroup !== true);
  if (!external) {
    throw new Error(`no external TestFlight group named "${group}": create it under TestFlight → External Testing (docs/ios_release.md, Part 9)`);
  }

  let submitted = true;
  try {
    await api("POST", "/v1/betaAppReviewSubmissions", {
      data: { type: "betaAppReviewSubmissions", relationships: { build: { data: buildRef } } },
    });
    log("submitted to Beta App Review");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) throw error;
    submitted = false;
    warn(`Beta App Review did not take build ${buildNumber(version)}: ${error.message}`);
  }

  await api("POST", `/v1/betaGroups/${external.id}/relationships/builds`, { data: [buildRef] });
  log(`added to the external group "${group}"${submitted ? "; testers get it once the review passes" : ""}`);
  return { buildId: build.id, submitted };
}

async function main() {
  const env = process.env;
  const missing = ["VERSION", "APPLE_API_KEY_PATH", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "IOS_APP_STORE_APP_ID"]
    .filter((name) => !String(env[name] ?? "").trim());
  if (missing.length) {
    console.error(`missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  const keyPem = readFileSync(env.APPLE_API_KEY_PATH, "utf8");
  const api = client({
    token: () => apiToken({ keyPem, keyId: env.APPLE_API_KEY_ID, issuerId: env.APPLE_API_ISSUER_ID }),
  });
  const { submitted } = await submit(api, {
    appId: env.IOS_APP_STORE_APP_ID.trim(),
    version: env.VERSION,
    group: (env.TESTFLIGHT_GROUP || "Beta").trim(),
    whatToTest: (env.WHAT_TO_TEST || "").trim() || defaultWhatToTest(env.VERSION, env.GITHUB_REPOSITORY),
    // A GitHub Actions warning shows on the run's summary page.
    warn: (message) => console.log(env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`),
  });
  if (!submitted) console.log("not submitted; the next release submits its own build");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
