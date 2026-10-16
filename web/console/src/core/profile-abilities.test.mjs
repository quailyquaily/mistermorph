import assert from "node:assert/strict";
import test from "node:test";

import { profileAbilitySummaryKeys } from "./profile-abilities.js";

test("profile abilities read as sentences", () => {
  const short = (abilities) => profileAbilitySummaryKeys(abilities).map((key) => key.replace("settings_llm_abilities_summary_", ""));

  assert.deepEqual(short(["text"]), ["text"]);
  assert.deepEqual(short(["text", "image", "decision"]), ["text", "also_image", "also_decision"]);
  assert.deepEqual(short(["decision"]), ["decision_only"]);
  assert.deepEqual(short(["decision", "image"]), ["decision_only", "also_image"]);
  assert.deepEqual(short(["image"]), ["image_only"]);
  assert.deepEqual(short([]), []);
});
