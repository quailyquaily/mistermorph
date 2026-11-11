import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIST_WORKER_NAME_POOLS,
  DEFAULT_WORKER_NAME_SET,
  LEGACY_WORKER_NAME_POOLS,
  MUSICIAN_WORKER_NAME_POOLS,
  WORKER_NAME_POOLS,
  WORKER_NAME_POOL_SIZE,
  WORKER_NAME_SETS,
  WORKER_NAME_SET_POOLS,
  normalizeWorkerNameSet,
  readWorkerIndices,
  workerDisplayName,
  workerNameExamples,
  workerNameIndex,
  workerNamePool,
} from "./worker-identity.js";
import { normalizeActivityWorkers } from "./chat-workers.js";

const LANGS = ["en", "zh", "ja"];

test("the name sets are scientists (the default), musicians and artists", () => {
  assert.deepEqual(WORKER_NAME_SETS, ["scientists", "musicians", "artists"]);
  assert.equal(DEFAULT_WORKER_NAME_SET, "scientists");
  assert.equal(WORKER_NAME_SET_POOLS.scientists, WORKER_NAME_POOLS);
  assert.equal(WORKER_NAME_SET_POOLS.musicians, MUSICIAN_WORKER_NAME_POOLS);
  assert.equal(WORKER_NAME_SET_POOLS.artists, ARTIST_WORKER_NAME_POOLS);
});

test("missing or unknown sets read as the scientists", () => {
  for (const [value, want] of [
    ["musicians", "musicians"],
    [" Artists ", "artists"],
    ["SCIENTISTS", "scientists"],
    ["", "scientists"],
    [undefined, "scientists"],
    [null, "scientists"],
    ["poets", "scientists"],
    ["toString", "scientists"],
    [42, "scientists"],
  ]) {
    assert.equal(normalizeWorkerNameSet(value), want, String(value));
  }
});

test("every set has the same people at the same positions in every language, without repeats", () => {
  const seen = new Map();
  for (const set of WORKER_NAME_SETS) {
    const pools = WORKER_NAME_SET_POOLS[set];
    assert.deepEqual(Object.keys(pools).sort(), [...LANGS].sort());
    for (const lang of LANGS) {
      const pool = pools[lang];
      assert.equal(pool.length, WORKER_NAME_POOL_SIZE, `${set} ${lang}`);
      assert.equal(new Set(pool).size, pool.length, `${set} ${lang} repeats a name`);
      for (const name of pool) {
        // A suffix is added after a dash, so no name may contain one.
        assert.ok(name && name === name.trim() && !name.includes("-"), `${set} ${lang}: ${name}`);
        // No two sets (nor the legacy pool) share a name in any language.
        const key = `${lang}:${name}`;
        assert.ok(!seen.has(key), `${name} is in ${seen.get(key)} and ${set}`);
        seen.set(key, set);
        assert.ok(!LEGACY_WORKER_NAME_POOLS[lang].includes(name), `${name} is a legacy name`);
      }
    }
  }
  const at = (pools, en) => LANGS.map((lang) => pools[lang][pools.en.indexOf(en)]);
  assert.deepEqual(at(MUSICIAN_WORKER_NAME_POOLS, "Bach"), ["Bach", "巴赫", "バッハ"]);
  assert.deepEqual(at(MUSICIAN_WORKER_NAME_POOLS, "Chopin"), ["Chopin", "肖邦", "ショパン"]);
  assert.deepEqual(at(MUSICIAN_WORKER_NAME_POOLS, "Sakamoto"), ["Sakamoto", "坂本龙一", "坂本龍一"]);
  assert.deepEqual(at(ARTIST_WORKER_NAME_POOLS, "Leonardo"), ["Leonardo", "达·芬奇", "ダ・ヴィンチ"]);
  assert.deepEqual(at(ARTIST_WORKER_NAME_POOLS, "Van Gogh"), ["Van Gogh", "梵高", "ゴッホ"]);
  assert.deepEqual(at(ARTIST_WORKER_NAME_POOLS, "Hokusai"), ["Hokusai", "葛饰北斋", "北斎"]);
});

test("a set's pool and examples follow the Console language", () => {
  assert.equal(workerNamePool("zh", "musicians"), MUSICIAN_WORKER_NAME_POOLS.zh);
  assert.equal(workerNamePool("fr", "artists"), ARTIST_WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool("ja"), WORKER_NAME_POOLS.ja);
  assert.equal(workerNamePool("en", "poets"), WORKER_NAME_POOLS.en);
  assert.deepEqual(workerNameExamples("scientists", "en"), ["Einstein", "Curie", "Newton", "Darwin"]);
  assert.deepEqual(workerNameExamples("musicians", "en"), ["Bach", "Mozart", "Beethoven", "Chopin"]);
  assert.deepEqual(workerNameExamples("artists", "ja", 3), ["ダ・ヴィンチ", "ミケランジェロ", "ラファエロ"]);
  assert.deepEqual(workerNameExamples("", "zh", 2), ["爱因斯坦", "居里"]);
});

test("a worker shows from the set it was named from, in each language", () => {
  const musician = { id: "worker-1", name: "Chopin", name_set: "musicians", name_index: 3 };
  assert.deepEqual(LANGS.map((lang) => workerDisplayName(musician, lang)), ["Chopin", "肖邦", "ショパン"]);
  const repeat = { id: "worker-40", name: "Van Gogh-2", name_set: "artists", name_index: WORKER_NAME_POOL_SIZE + 5 };
  assert.deepEqual(LANGS.map((lang) => workerDisplayName(repeat, lang)), ["Van Gogh-2", "梵高-2", "ゴッホ-2"]);
  // Normalized records (nameSet) read the same.
  assert.equal(workerDisplayName({ id: "worker-1", name: "Bach", nameSet: "musicians", nameIndex: 0 }, "zh"), "巴赫");
  // Without an index the English name is read back in its set.
  assert.equal(workerDisplayName({ id: "worker-1", name: "Mozart-3", name_set: "musicians" }, "ja"), "モーツァルト-3");
  assert.equal(workerNameIndex({ name: "Mozart-3", name_set: "musicians" }), 2 * WORKER_NAME_POOL_SIZE + 1);
  // A set with an index and no name names the person there.
  assert.equal(workerDisplayName({ id: "worker-1", name_set: "artists", name_index: 1 }, "zh"), "米开朗基罗");
});

test("recorded names never move to the set preferred now", () => {
  // Records from before name sets: scientists and legacy names stay as they were.
  const scientist = { id: "worker-1", name: "Darwin", name_index: 3 };
  const legacy = { id: "worker-2", name: "Cleo", name_index: 3 };
  const unindexed = { id: "worker-3", name: "Curie" };
  const bare = { id: "worker-4", name_index: 3 };
  for (const lang of LANGS) {
    assert.equal(workerDisplayName(scientist, lang), WORKER_NAME_POOLS[lang][3]);
    assert.equal(workerDisplayName(legacy, lang), LEGACY_WORKER_NAME_POOLS[lang][3]);
    assert.equal(workerDisplayName(unindexed, lang), WORKER_NAME_POOLS[lang][1]);
    assert.equal(workerDisplayName(bare, lang), WORKER_NAME_POOLS[lang][3]);
  }
  // A set that does not match the recorded name, or one this Console does not know, shows the
  // recorded name as it is.
  assert.equal(workerDisplayName({ id: "worker-1", name: "Darwin", name_set: "musicians", name_index: 3 }, "zh"), "Darwin");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Bach", name_set: "scientists", name_index: 0 }, "zh"), "Bach");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Homer", name_set: "poets", name_index: 0 }, "zh"), "Homer");
  assert.equal(workerNameIndex({ name: "Homer", name_set: "poets", name_index: 0 }), null);
  // A record whose set was lost on the way still shows its own person, never another set's.
  assert.equal(workerDisplayName({ id: "worker-1", name: "Chopin", name_index: 3 }, "zh"), "肖邦");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Turner", name_index: 20 }, "ja"), "ターナー");
});

test("worker records keep their name set through normalization", () => {
  assert.deepEqual(readWorkerIndices({ name_set: "Musicians", name_index: 3, avatar_index: 1 }), {
    nameSet: "musicians",
    nameIndex: 3,
    avatarIndex: 1,
  });
  assert.deepEqual(readWorkerIndices({ nameSet: "poets" }), { nameSet: "poets" });
  assert.deepEqual(readWorkerIndices({ name_index: 3 }), { nameIndex: 3 });
  assert.deepEqual(readWorkerIndices({ name_set: "  " }), {});
  // The roster keeps the set across repeated normalization (live updates, then a reload).
  const raw = [
    { id: "worker-1", name: "Chopin", name_set: "musicians", name_index: 3, avatar_index: 2, kind: "subagent" },
    { id: "worker-2", name: "Darwin", name_index: 3, avatar_index: 4, kind: "coder" },
  ];
  const once = normalizeActivityWorkers(raw);
  const twice = normalizeActivityWorkers(once);
  assert.deepEqual(twice, once);
  assert.equal(once[0].nameSet, "musicians");
  assert.equal(once[1].nameSet, undefined);
  assert.equal(workerDisplayName(twice[0], "zh"), "肖邦");
  assert.equal(workerDisplayName(twice[1], "zh"), "达尔文");
});
