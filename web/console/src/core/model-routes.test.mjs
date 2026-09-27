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

import { addToSplit, removeFromSplit, setShare, toggleFallback, useProfile } from "./model-routes.js";

const shares = (route) => route.candidates.map((item) => `${item.profile}:${item.weight}`).join(" ");

test("map edits: use, split, remove, fallback", () => {
  const unset = routeFromValue({});
  const one = useProfile(unset, "cheap");
  assert.deepEqual(routeToValue(one), { profile: "cheap" });

  // Splitting from one profile keeps it and adds the new one at an equal share.
  const two = addToSplit(one, "backup");
  assert.equal(shares(two), "cheap:50 backup:50");
  const three = addToSplit(two, "nest");
  assert.equal(shares(three), "cheap:34 backup:33 nest:33");
  assert.equal(three.candidates.reduce((sum, item) => sum + item.weight, 0), 100);
  // Splitting from the default route starts from "default".
  assert.equal(shares(addToSplit(unset, "cheap")), "default:50 cheap:50");

  // Removing down to one profile turns the split back into that profile.
  assert.deepEqual(routeToValue(removeFromSplit(two, "cheap")), { profile: "backup" });

  // Fallbacks keep their order; a profile used directly stops being a fallback.
  const withFallbacks = toggleFallback(toggleFallback(one, "backup"), "default");
  assert.deepEqual(withFallbacks.fallbacks, ["backup", "default"]);
  assert.deepEqual(toggleFallback(withFallbacks, "backup").fallbacks, ["default"]);
  assert.deepEqual(useProfile(withFallbacks, "backup").fallbacks, ["default"]);
  // The input route is never changed.
  assert.deepEqual(routeToValue(one), { profile: "cheap" });
});

test("setShare keeps a split adding up to 100", () => {
  const split = addToSplit(addToSplit(routeFromValue({ profile: "a" }), "b"), "c");
  const moved = setShare(split, 0, 70);
  assert.equal(moved.candidates[0].weight, 70);
  assert.equal(moved.candidates.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(setShare(split, 0, 100).candidates[0].weight, 98);
  assert.equal(setShare(split, 0, 0).candidates[0].weight, 1);
});
