import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import {
  LEGACY_WORKER_NAME_POOLS,
  WORKER_AVATAR_STYLES,
  WORKER_NAME_POOLS,
  WORKER_NAME_POOL_SIZE,
  readWorkerIndices,
  workerAvatarIndex,
  workerAvatarStyle,
  workerDisplayName,
  workerNameIndex,
  workerNamePool,
} from "./worker-identity.js";

const LANGS = ["en", "zh", "ja"];
const HAN = /^\p{Script=Han}+$/u;
const KATAKANA = /^[\p{Script=Katakana}ー]+$/u;

test("every Console language names the same scientists, in a pool of the same size without repeats", () => {
  for (const pools of [WORKER_NAME_POOLS, LEGACY_WORKER_NAME_POOLS]) {
    assert.deepEqual(Object.keys(pools).sort(), [...LANGS].sort());
    for (const lang of LANGS) {
      const pool = pools[lang];
      assert.equal(pool.length, WORKER_NAME_POOL_SIZE, lang);
      assert.equal(new Set(pool).size, pool.length, `${lang} repeats a name`);
      for (const name of pool) {
        // A suffix is added after a dash, so no name may contain one.
        assert.ok(name && name === name.trim() && !name.includes("-"), `${lang}: ${name}`);
      }
    }
  }
  // The size is part of every recorded name index.
  assert.equal(WORKER_NAME_POOL_SIZE, 32);
  assert.ok(WORKER_NAME_POOLS.en.every((name) => /^[A-Z][a-z]+$/u.test(name)));
  assert.ok(WORKER_NAME_POOLS.zh.every((name) => HAN.test(name) && [...name].length >= 2));
  assert.ok(WORKER_NAME_POOLS.ja.every((name) => KATAKANA.test(name) && [...name].length >= 2));
  for (const name of ["Einstein", "Curie", "Newton", "Darwin", "Noether"]) {
    assert.ok(WORKER_NAME_POOLS.en.includes(name), name);
  }
  // The same scientist at each position, in the form conventional in each language.
  const at = (en) => LANGS.map((lang) => WORKER_NAME_POOLS[lang][WORKER_NAME_POOLS.en.indexOf(en)]);
  assert.deepEqual(at("Einstein"), ["Einstein", "爱因斯坦", "アインシュタイン"]);
  assert.deepEqual(at("Curie"), ["Curie", "居里", "キュリー"]);
  assert.deepEqual(at("Newton"), ["Newton", "牛顿", "ニュートン"]);
  assert.deepEqual(at("Darwin"), ["Darwin", "达尔文", "ダーウィン"]);
  assert.deepEqual(at("Noether"), ["Noether", "诺特", "ネーター"]);
  assert.deepEqual(at("Turing"), ["Turing", "图灵", "チューリング"]);
  assert.deepEqual(at("Archimedes"), ["Archimedes", "阿基米德", "アルキメデス"]);
  // No scientist shares a name with the ordinary names of older records, in any language, so
  // a recorded name tells which pool it came from.
  for (const lang of LANGS) {
    assert.equal(WORKER_NAME_POOLS[lang].filter((name) => LEGACY_WORKER_NAME_POOLS[lang].includes(name)).length, 0, lang);
  }
  // The legacy pools are frozen history.
  assert.deepEqual(LEGACY_WORKER_NAME_POOLS.en.slice(0, 8), ["Milo", "Luna", "Pip", "Cleo", "Finn", "Nova", "Remy", "Iris"]);
  assert.equal(LEGACY_WORKER_NAME_POOLS.en[31], "Zoe");
  assert.equal(LEGACY_WORKER_NAME_POOLS.zh[0], "张伟");
  assert.equal(LEGACY_WORKER_NAME_POOLS.ja[0], "佐藤健");
});

test("a name index shows the same position in each language, with a suffix once the pool is used up", () => {
  const worker = (nameIndex) => ({ id: "worker-1", name_index: nameIndex });
  for (const lang of LANGS) {
    const pool = WORKER_NAME_POOLS[lang];
    const firstRound = pool.map((_, i) => workerDisplayName(worker(i), lang));
    assert.deepEqual(firstRound, pool);
    assert.equal(workerDisplayName(worker(WORKER_NAME_POOL_SIZE + 4), lang), `${pool[4]}-2`);
    assert.equal(workerDisplayName(worker(2 * WORKER_NAME_POOL_SIZE), lang), `${pool[0]}-3`);
    const many = Array.from({ length: 3 * WORKER_NAME_POOL_SIZE }, (_, i) => workerDisplayName(worker(i), lang));
    assert.equal(new Set(many).size, many.length, `${lang}: suffixed names stay distinct`);
  }
  // A record as the runtime writes it: the English name at its index.
  const runtime = (nameIndex) => ({ id: "worker-1", name: workerDisplayName(worker(nameIndex), "en"), name_index: nameIndex });
  assert.deepEqual(runtime(1).name, "Curie");
  assert.equal(workerDisplayName(runtime(1), "zh"), "居里");
  assert.equal(workerDisplayName(runtime(WORKER_NAME_POOL_SIZE + 2), "ja"), "ニュートン-2");
  assert.equal(workerDisplayName(runtime(WORKER_NAME_POOL_SIZE + 2), "en"), "Newton-2");
});

test("languages without a pool use English", () => {
  assert.equal(workerNamePool("fr"), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool(""), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool(undefined), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool("toString"), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool("zh-CN"), WORKER_NAME_POOLS.zh);
  assert.equal(workerNamePool("JA_jp"), WORKER_NAME_POOLS.ja);
  assert.equal(workerDisplayName({ id: "worker-1", name: "Curie", name_index: 1 }, "de"), "Curie");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Luna", name_index: 1 }, "de"), "Luna");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Luna", name_index: 1 }, "zh-TW"), "林悦");
});

test("switching the language and back changes only the name", () => {
  const worker = { id: "worker-7", name: "Mendel", name_index: 14, avatar_index: 3 };
  const seen = LANGS.concat(["fr", "en"]).map((lang) => [workerDisplayName(worker, lang), workerAvatarStyle(worker), worker.id]);
  assert.deepEqual(seen, [
    ["Mendel", "suimen", "worker-7"], ["孟德尔", "suimen", "worker-7"], ["メンデル", "suimen", "worker-7"],
    ["Mendel", "suimen", "worker-7"], ["Mendel", "suimen", "worker-7"],
  ]);
});

test("records from before the scientist pool keep their ordinary names", () => {
  // Indexed: the name the runtime gave then at that index, not the scientist now there.
  const old = { id: "worker-7", name: "Owen", name_index: 14, avatar_index: 3 };
  assert.equal(workerNameIndex(old), 14);
  assert.deepEqual(LANGS.concat(["fr", "en"]).map((lang) => workerDisplayName(old, lang)), ["Owen", "朱琳", "松本樹", "Owen", "Owen"]);
  assert.equal(workerAvatarStyle(old), "suimen");
  assert.equal(workerDisplayName({ id: "x", name: "Ada", nameIndex: 9 }, "zh"), "周涛");
  // Suffixed repeats.
  assert.deepEqual(LANGS.map((lang) => workerDisplayName({ id: "worker-40", name: "Pip-2", name_index: WORKER_NAME_POOL_SIZE + 2 }, lang)), ["Pip-2", "王芳-2", "高橋蓮-2"]);
  // A name that is not the one at its index, from either pool, is shown as recorded rather than
  // relabelled from the index.
  for (const worker of [
    { id: "worker-1", name: "Luna", name_index: 0 },
    { id: "worker-1", name: "Curie", name_index: 0 },
    { id: "worker-1", name: "Custom", name_index: 3 },
    { id: "worker-1", name: "Milo-2", name_index: 0 },
  ]) {
    assert.equal(workerNameIndex(worker), null, worker.name);
    for (const lang of LANGS) {
      assert.equal(workerDisplayName(worker, lang), worker.name);
    }
  }
});

test("records without indices fall back deterministically", () => {
  // Legacy English names map back to their position in the legacy pools, suffix included.
  assert.equal(workerNameIndex({ name: "Milo" }), 0);
  assert.equal(workerNameIndex({ name: "Iris" }), 7);
  assert.equal(workerNameIndex({ name: "Milo-2" }), WORKER_NAME_POOL_SIZE);
  assert.equal(workerDisplayName({ id: "worker-9", name: "Nova-3" }, "zh"), "陈静-3");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Milo" }, "ja"), "佐藤健");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Milo" }, "en"), "Milo");
  // Scientist names map back to theirs.
  assert.equal(workerNameIndex({ name: "Curie" }), 1);
  assert.equal(workerNameIndex({ name: "Curie-2" }), WORKER_NAME_POOL_SIZE + 1);
  assert.equal(workerDisplayName({ id: "worker-1", name: "Darwin-2" }, "zh"), "达尔文-2");
  // An index alone picks the scientist.
  assert.equal(workerDisplayName({ id: "worker-1", name_index: 0 }, "ja"), "アインシュタイン");
  // Anything else shows as recorded, in every language.
  for (const name of ["W1", "Milo-1", "Milo-02", "milo", "Juno", "Curie-1", "curie", "Einstein-0"]) {
    for (const lang of LANGS) {
      assert.equal(workerDisplayName({ id: "worker-1", name }, lang), name);
    }
  }
  assert.equal(workerDisplayName({ id: "w" }, "en"), "");
  // Avatars: numbered workers take the styles in order; other ids a fixed hash.
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => workerAvatarIndex({ id: `worker-${i + 1}` })), [0, 1, 2, 3, 4, 5, 6, 0, 1]);
  assert.equal(workerAvatarIndex({ id: "coder-worker" }), workerAvatarIndex({ id: "coder-worker", name: "Other" }));
  assert.ok(workerAvatarIndex({ id: "coder-worker" }) < WORKER_AVATAR_STYLES.length);
  assert.equal(workerAvatarIndex({ id: "worker-1", name: "Milo" }), workerAvatarIndex({ id: "worker-1", name: "Curie" }));
  // Invalid recorded values are ignored rather than trusted.
  assert.equal(workerNameIndex({ name: "Luna", name_index: -1 }), 1);
  assert.equal(workerNameIndex({ name: "Luna", name_index: 1.5 }), 1);
  assert.equal(workerNameIndex({ name: "Curie", name_index: "x" }), 1);
  assert.equal(workerAvatarIndex({ id: "worker-2", avatar_index: null }), 1);
  assert.equal(workerAvatarIndex({ id: "worker-2", avatar_index: 13 }), 6);
  assert.deepEqual(readWorkerIndices({ name_index: 0, avatar_index: 0 }), { nameIndex: 0, avatarIndex: 0 });
  assert.deepEqual(readWorkerIndices({ nameIndex: 3 }), { nameIndex: 3 });
  assert.deepEqual(readWorkerIndices({ name_index: "x" }), {});
  assert.deepEqual(readWorkerIndices(null), {});
});

test("the avatar styles are the brand colourways shipped as assets, each once", async () => {
  assert.equal(new Set(WORKER_AVATAR_STYLES).size, WORKER_AVATAR_STYLES.length);
  const assets = (await readdir(new URL("../../assets/worker-avatars/", import.meta.url))).filter((file) => file.endsWith(".svg"));
  assert.deepEqual(assets.map((file) => file.replace(/\.svg$/u, "")).sort(), [...WORKER_AVATAR_STYLES].sort());
  const icons = await readdir(new URL("../../../../design/brand/icons/", import.meta.url));
  assert.deepEqual(icons.sort(), [...WORKER_AVATAR_STYLES].sort());
});
