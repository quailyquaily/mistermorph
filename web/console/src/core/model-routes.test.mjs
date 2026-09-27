import assert from "node:assert/strict";
import test from "node:test";

import { percentWeights, routeFromValue, routeProblems, routeShares, routeTargets, routeToValue } from "./model-routes.js";

test("routeFromValue reads every form the config accepts", () => {
  const cases = [
    { name: "unset", value: null, mode: "default" },
    { name: "empty object", value: {}, mode: "default" },
    { name: "profile name", value: "cheap", mode: "profile", profile: "cheap" },
    { name: "profile object", value: { profile: "cheap", fallback_profiles: ["default", "default"] }, mode: "profile", profile: "cheap", fallbacks: ["default"] },
    {
      name: "candidates",
      value: { candidates: [{ profile: "a", weight: 3 }, { profile: "b", weight: 1 }] },
      mode: "split",
      candidates: [{ profile: "a", weight: 3 }, { profile: "b", weight: 1 }],
    },
  ];
  for (const item of cases) {
    const route = routeFromValue(item.value);
    assert.equal(route.mode, item.mode, item.name);
    assert.equal(route.profile, item.profile || "", item.name);
    assert.deepEqual(route.candidates, item.candidates || [], item.name);
    assert.deepEqual(route.fallbacks, item.fallbacks || [], item.name);
  }
});

test("routeToValue writes only what the mode uses", () => {
  assert.deepEqual(routeToValue({ mode: "default", profile: "x", candidates: [{ profile: "a", weight: 1 }], fallbacks: [] }), {});
  assert.deepEqual(routeToValue({ mode: "profile", profile: "cheap", candidates: [], fallbacks: ["default"] }), {
    profile: "cheap",
    fallback_profiles: ["default"],
  });
  assert.deepEqual(routeToValue({ mode: "split", profile: "x", candidates: [{ profile: "a", weight: 2 }], fallbacks: [] }), {
    candidates: [{ profile: "a", weight: 2 }],
  });
});

test("routeProblems catches what the server would reject or fail on", () => {
  const known = ["default", "cheap"];
  assert.deepEqual(routeProblems(routeFromValue({ profile: "cheap" }), known), []);
  assert.deepEqual(routeProblems(routeFromValue({ profile: "gone" }), known), ['No profile is named "gone".']);
  assert.deepEqual(routeProblems(routeFromValue({ profile: "gone" }), null), []);
  assert.deepEqual(
    routeProblems(routeFromValue({ candidates: [{ profile: "", weight: 0 }] }), known),
    ["Share 1: choose a profile.", "Share 1: weight must be a whole number above 0."],
  );
});

test("routeShares gives whole percentages", () => {
  assert.deepEqual(routeShares([{ weight: 3 }, { weight: 1 }]), [75, 25]);
  assert.deepEqual(routeShares([{ weight: 0 }]), [0]);
});

test("routeTargets resolves an unset route to the default profile", () => {
  assert.deepEqual(routeTargets(routeFromValue({})), [{ profile: "default", share: 100 }]);
  assert.deepEqual(routeTargets(routeFromValue({ candidates: [{ profile: "a", weight: 1 }, { profile: "b", weight: 3 }] })), [
    { profile: "a", share: 25 },
    { profile: "b", share: 75 },
  ]);
});

test("percentWeights always adds up to 100", () => {
  assert.deepEqual(percentWeights([{ weight: 1 }, { weight: 1 }, { weight: 1 }]), [34, 33, 33]);
  assert.deepEqual(percentWeights([{ weight: 3 }, { weight: 1 }]), [75, 25]);
  assert.deepEqual(percentWeights([{ weight: 0 }, { weight: 0 }]), [50, 50]);
});
