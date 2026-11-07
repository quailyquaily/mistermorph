import assert from "node:assert/strict";
import test from "node:test";

import { endpointURLInsecure, insecureHops, isEndpointSelectable, rootEntryEndpoint } from "./endpoints.js";

test("connected and health-pending endpoints are selectable", () => {
  assert.equal(isEndpointSelectable({ endpoint_ref: "ep_connected", connected: true }), true);
  assert.equal(
    isEndpointSelectable({ endpoint_ref: "ep_pending", connected: false, health_pending: true }),
    true,
  );
  assert.equal(
    isEndpointSelectable({ endpoint_ref: "ep_offline", connected: false, health_pending: false }),
    false,
  );
});

test("root entry accepts a sole endpoint while its health check is pending", () => {
  const endpoint = {
    endpoint_ref: "ep_remote",
    connected: false,
    health_pending: true,
  };

  assert.equal(rootEntryEndpoint([endpoint]), endpoint);
});

test("root entry rejects disconnected and ambiguous endpoints", () => {
  assert.equal(
    rootEntryEndpoint([
      {
        endpoint_ref: "ep_remote",
        connected: false,
        health_pending: false,
      },
    ]),
    null
  );
  assert.equal(
    rootEntryEndpoint([
      { endpoint_ref: "ep_one", connected: true },
      { endpoint_ref: "ep_two", connected: true },
    ]),
    null
  );
});

test("endpointURLInsecure flags plain HTTP to another machine only", () => {
  for (const [url, insecure] of [
    ["http://10.0.0.5:8787", true],
    ["http://runtime.lan/api", true],
    ["https://runtime.example.com", false],
    ["http://127.0.0.1:8787", false],
    ["http://localhost:8787", false],
    ["http://box.localhost", false],
    ["http://[::1]:8787", false],
    ["in-process://console-local", false],
    ["", false],
    ["not a url", false],
  ]) {
    assert.equal(endpointURLInsecure(url), insecure, url);
  }
});

test("insecureHops tells the page apart from the Console's hop to the endpoint", () => {
  for (const [name, input, page, endpoint] of [
    ["HTTPS page, local runtime", { secureContext: true, endpointURLs: ["in-process://console-local"] }, false, ""],
    ["plain HTTP page", { secureContext: false }, true, ""],
    ["plain HTTP page in the desktop app", { desktop: true, secureContext: false }, false, ""],
    ["HTTPS page, runtime over plain HTTP", { secureContext: true, endpointURLs: ["in-process://console-local", "http://10.0.0.5:8787"] }, false, "10.0.0.5:8787"],
    ["desktop app, runtime over plain HTTP", { desktop: true, endpointURLs: ["http://10.0.0.5:8787"] }, false, "10.0.0.5:8787"],
    ["both hops", { secureContext: false, endpointURLs: [" http://box.lan/runtime "] }, true, "box.lan"],
    ["HTTPS page, runtime over HTTPS", { secureContext: true, endpointURLs: ["https://runtime.example.com", undefined] }, false, ""],
    ["nothing known", undefined, false, ""],
  ]) {
    assert.deepEqual(insecureHops(input), { page, endpoint }, name);
  }
});
