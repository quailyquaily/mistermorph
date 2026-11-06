import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import {
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
const JAPANESE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々]+$/u;

test("every Console language has its own pool of the same size, without repeats", () => {
  assert.deepEqual(Object.keys(WORKER_NAME_POOLS).sort(), [...LANGS].sort());
  assert.equal(WORKER_NAME_POOL_SIZE, 32);
  for (const lang of LANGS) {
    const pool = WORKER_NAME_POOLS[lang];
    assert.equal(pool.length, WORKER_NAME_POOL_SIZE, lang);
    assert.equal(new Set(pool).size, pool.length, `${lang} repeats a name`);
    for (const name of pool) {
      // A suffix is added after a dash, so no name may contain one.
      assert.ok(name && name === name.trim() && !name.includes("-"), `${lang}: ${name}`);
    }
  }
  // Names native to each language, not transliterations of the English ones.
  assert.ok(WORKER_NAME_POOLS.en.every((name) => /^[A-Z][a-z]+$/u.test(name)));
  assert.ok(WORKER_NAME_POOLS.zh.every((name) => HAN.test(name) && [...name].length >= 2 && [...name].length <= 3));
  assert.ok(WORKER_NAME_POOLS.ja.every((name) => JAPANESE.test(name) && [...name].length >= 2));
  assert.ok(WORKER_NAME_POOLS.zh.includes("张伟") && WORKER_NAME_POOLS.zh.includes("林悦"));
  // Chinese and Japanese pools are separate, even where both use kanji.
  assert.equal(WORKER_NAME_POOLS.zh.filter((name) => WORKER_NAME_POOLS.ja.includes(name)).length, 0);
  // The first eight are the names given before allocation was random, so older records keep theirs.
  assert.deepEqual(WORKER_NAME_POOLS.en.slice(0, 8), ["Milo", "Luna", "Pip", "Cleo", "Finn", "Nova", "Remy", "Iris"]);
});

test("a name index shows the same position in each language, with a suffix once the pool is used up", () => {
  const worker = (nameIndex) => ({ id: "worker-1", name: "ignored", name_index: nameIndex });
  for (const lang of LANGS) {
    const pool = WORKER_NAME_POOLS[lang];
    const firstRound = pool.map((_, i) => workerDisplayName(worker(i), lang));
    assert.deepEqual(firstRound, pool);
    assert.equal(workerDisplayName(worker(WORKER_NAME_POOL_SIZE + 4), lang), `${pool[4]}-2`);
    assert.equal(workerDisplayName(worker(2 * WORKER_NAME_POOL_SIZE), lang), `${pool[0]}-3`);
    const many = Array.from({ length: 3 * WORKER_NAME_POOL_SIZE }, (_, i) => workerDisplayName(worker(i), lang));
    assert.equal(new Set(many).size, many.length, `${lang}: suffixed names stay distinct`);
  }
  assert.equal(workerDisplayName({ id: "x", name: "Ada", nameIndex: 9 }, "zh"), "周涛");
});

test("languages without a pool use English", () => {
  assert.equal(workerNamePool("fr"), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool(""), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool(undefined), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool("toString"), WORKER_NAME_POOLS.en);
  assert.equal(workerNamePool("zh-CN"), WORKER_NAME_POOLS.zh);
  assert.equal(workerNamePool("JA_jp"), WORKER_NAME_POOLS.ja);
  assert.equal(workerDisplayName({ id: "worker-1", name: "Luna", name_index: 1 }, "de"), "Luna");
});

test("switching the language and back changes only the name", () => {
  const worker = { id: "worker-7", name: "Owen", name_index: 14, avatar_index: 3 };
  const seen = LANGS.concat(["en"]).map((lang) => [workerDisplayName(worker, lang), workerAvatarStyle(worker), worker.id]);
  assert.deepEqual(seen, [["Owen", "suimen", "worker-7"], ["朱琳", "suimen", "worker-7"], ["松本樹", "suimen", "worker-7"], ["Owen", "suimen", "worker-7"]]);
});

test("records without indices fall back deterministically", () => {
  // Legacy English names map back to their pool position, suffix included.
  assert.equal(workerNameIndex({ name: "Milo" }), 0);
  assert.equal(workerNameIndex({ name: "Iris" }), 7);
  assert.equal(workerNameIndex({ name: "Milo-2" }), WORKER_NAME_POOL_SIZE);
  assert.equal(workerDisplayName({ id: "worker-9", name: "Nova-3" }, "zh"), "陈静-3");
  assert.equal(workerDisplayName({ id: "worker-1", name: "Milo" }, "ja"), "佐藤健");
  // Anything else shows as recorded, in every language.
  for (const name of ["W1", "Milo-1", "Milo-02", "milo", "Juno"]) {
    for (const lang of LANGS) {
      assert.equal(workerDisplayName({ id: "worker-1", name }, lang), name);
    }
  }
  assert.equal(workerDisplayName({ id: "w" }, "en"), "");
  // Avatars: numbered workers take the styles in order; other ids a fixed hash.
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => workerAvatarIndex({ id: `worker-${i + 1}` })), [0, 1, 2, 3, 4, 5, 6, 0, 1]);
  assert.equal(workerAvatarIndex({ id: "coder-worker" }), workerAvatarIndex({ id: "coder-worker", name: "Other" }));
  assert.ok(workerAvatarIndex({ id: "coder-worker" }) < WORKER_AVATAR_STYLES.length);
  assert.equal(workerAvatarIndex({ id: "worker-1", name: "Milo" }), workerAvatarIndex({ id: "worker-1", name: "Luna" }));
  // Invalid recorded values are ignored rather than trusted.
  assert.equal(workerNameIndex({ name: "Luna", name_index: -1 }), 1);
  assert.equal(workerNameIndex({ name: "Luna", name_index: 1.5 }), 1);
  assert.equal(workerAvatarIndex({ id: "worker-2", avatar_index: null }), 1);
  assert.equal(workerAvatarIndex({ id: "worker-2", avatar_index: 13 }), 6);
  assert.deepEqual(readWorkerIndices({ name_index: 0, avatar_index: 0 }), { nameIndex: 0, avatarIndex: 0 });
  assert.deepEqual(readWorkerIndices({ nameIndex: 3 }), { nameIndex: 3 });
  assert.deepEqual(readWorkerIndices({ name_index: "x" }), {});
  assert.deepEqual(readWorkerIndices(null), {});
});

test("the avatar styles are the brand colourways shipped as assets, each once", async () => {
  assert.equal(new Set(WORKER_AVATAR_STYLES).size, WORKER_AVATAR_STYLES.length);
  const assets = (await readdir(new URL("../assets/worker-avatars/", import.meta.url))).filter((file) => file.endsWith(".svg"));
  assert.deepEqual(assets.map((file) => file.replace(/\.svg$/u, "")).sort(), [...WORKER_AVATAR_STYLES].sort());
  const icons = await readdir(new URL("../../../../design/brand/icons/", import.meta.url));
  assert.deepEqual(icons.sort(), [...WORKER_AVATAR_STYLES].sort());
});
