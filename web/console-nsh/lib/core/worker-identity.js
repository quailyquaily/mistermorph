// What a worker looks like: its name in the Console's language and its logo style. The runtime
// allocates both at random for each task and records them as indices (name_index and
// avatar_index), so a worker keeps the same picks through reloads and resumes, and switching the
// language changes only the name shown. The worker's identity is its id, never its name.

// The name pools: famous scientists. Every language names the same scientist at the same
// position, in the form conventional there (Einstein, 爱因斯坦, アインシュタイン), and every pool has
// the same size, because a name index picks the same position in each. The English pool is the
// runtime's (agent/worker.go) and must stay the same list in the same order.
export const WORKER_NAME_POOLS = Object.freeze({
  en: Object.freeze([
    "Einstein", "Curie", "Newton", "Darwin", "Noether", "Galileo", "Turing", "Lovelace",
    "Faraday", "Maxwell", "Bohr", "Planck", "Kepler", "Pasteur", "Mendel", "Hopper",
    "Franklin", "Feynman", "Hubble", "Tesla", "Euler", "Gauss", "Lavoisier", "Mendeleev",
    "Hawking", "Meitner", "Fermi", "Dirac", "Copernicus", "Ramanujan", "Goodall", "Archimedes",
  ]),
  zh: Object.freeze([
    "爱因斯坦", "居里", "牛顿", "达尔文", "诺特", "伽利略", "图灵", "洛夫莱斯",
    "法拉第", "麦克斯韦", "玻尔", "普朗克", "开普勒", "巴斯德", "孟德尔", "霍珀",
    "富兰克林", "费曼", "哈勃", "特斯拉", "欧拉", "高斯", "拉瓦锡", "门捷列夫",
    "霍金", "迈特纳", "费米", "狄拉克", "哥白尼", "拉马努金", "古道尔", "阿基米德",
  ]),
  ja: Object.freeze([
    "アインシュタイン", "キュリー", "ニュートン", "ダーウィン", "ネーター", "ガリレオ", "チューリング", "ラブレス",
    "ファラデー", "マクスウェル", "ボーア", "プランク", "ケプラー", "パスツール", "メンデル", "ホッパー",
    "フランクリン", "ファインマン", "ハッブル", "テスラ", "オイラー", "ガウス", "ラボアジエ", "メンデレーエフ",
    "ホーキング", "マイトナー", "フェルミ", "ディラック", "コペルニクス", "ラマヌジャン", "グドール", "アルキメデス",
  ]),
});

// The ordinary first names workers had before they were named after scientists. Records the
// runtime wrote then carry one of these English names, often with the index it was drawn at; they
// keep showing it (in each language's legacy pool) rather than turning into whichever scientist
// now sits at that index. The lists and their order are frozen history: never edit them.
export const LEGACY_WORKER_NAME_POOLS = Object.freeze({
  en: Object.freeze([
    "Milo", "Luna", "Pip", "Cleo", "Finn", "Nova", "Remy", "Iris",
    "John", "Ada", "Theo", "Ruby", "Jack", "Hazel", "Owen", "Mia",
    "Leo", "Ivy", "Sam", "Nora", "Felix", "June", "Max", "Rose",
    "Eli", "Maya", "Gus", "Ella", "Oscar", "Lily", "Ben", "Zoe",
  ]),
  zh: Object.freeze([
    "张伟", "林悦", "王芳", "李娜", "刘洋", "陈静", "杨帆", "赵磊",
    "黄婷", "周涛", "吴昊", "徐丽", "孙浩", "胡敏", "朱琳", "高翔",
    "郭佳", "何欣", "马骏", "罗晴", "梁斌", "宋雨", "郑凯", "谢雯",
    "韩冰", "唐宁", "冯晨", "于倩", "董鹏", "萧然", "程雪", "曹阳",
  ]),
  ja: Object.freeze([
    "佐藤健", "鈴木葵", "高橋蓮", "田中陽菜", "伊藤湊", "渡辺結衣", "山本悠真", "中村さくら",
    "小林大翔", "加藤美咲", "吉田蒼", "山田花", "佐々木翼", "山口凛", "松本樹", "井上楓",
    "木村颯", "林美月", "斎藤陸", "清水結菜", "山崎拓海", "森彩", "池田悠斗", "橋本芽衣",
    "阿部翔", "石川杏", "山下航", "中島千尋", "前田誠", "藤田遥", "小川直樹", "岡田舞",
  ]),
});

export const WORKER_NAME_POOL_SIZE = WORKER_NAME_POOLS.en.length;

// The logo styles, by avatar index: the brand's colourways (design/brand/icons), each the 64
// circle drawing in src/assets/worker-avatars. The order is part of the recorded indices.
export const WORKER_AVATAR_STYLES = Object.freeze(["aojashin", "night", "paper", "suimen", "rinko", "bunko", "denko"]);

function text(value) {
  return String(value ?? "").trim();
}

function index(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function poolFor(pools, lang) {
  const key = text(lang).toLowerCase().split(/[-_]/u)[0];
  return Object.hasOwn(pools, key) ? pools[key] : pools.en;
}

// workerNamePool is the scientist pool for a Console language; a language without one uses English.
export function workerNamePool(lang) {
  return poolFor(WORKER_NAME_POOLS, lang);
}

function nameAt(pool, nameIndex) {
  const round = Math.floor(nameIndex / pool.length);
  const name = pool[nameIndex % pool.length];
  return round > 0 ? `${name}-${round + 1}` : name;
}

// englishNameIndex reads a name index back from an English name in pools ("Curie", or "Curie-2"
// for a repeat). A name not in the pool has none.
function englishNameIndex(pools, name) {
  const match = /^(.+?)(?:-([2-9]|[1-9]\d+))?$/u.exec(text(name));
  if (!match) return null;
  const position = pools.en.indexOf(match[1]);
  if (position < 0) return null;
  const round = match[2] ? Number(match[2]) - 1 : 0;
  return round * pools.en.length + position;
}

// resolveWorkerName decides which pools and index name a worker, or null to show the recorded name
// as it is. A recorded index is trusted when the recorded name is the one the runtime gives at that
// index, from the scientist pools or, for older records, the legacy ones, or when there is no
// name; a record without an index is read back from its English name. Anything else (a name from
// neither pool, or one that does not match its index) is not relabelled.
function resolveWorkerName(worker) {
  const name = text(worker?.name);
  const recorded = index(worker?.nameIndex ?? worker?.name_index);
  if (recorded !== null) {
    if (!name || nameAt(WORKER_NAME_POOLS.en, recorded) === name) {
      return { pools: WORKER_NAME_POOLS, nameIndex: recorded };
    }
    if (nameAt(LEGACY_WORKER_NAME_POOLS.en, recorded) === name) {
      return { pools: LEGACY_WORKER_NAME_POOLS, nameIndex: recorded };
    }
    return null;
  }
  for (const pools of [WORKER_NAME_POOLS, LEGACY_WORKER_NAME_POOLS]) {
    const nameIndex = englishNameIndex(pools, name);
    if (nameIndex !== null) return { pools, nameIndex };
  }
  return null;
}

// workerNameIndex is the index the worker's name is shown from (in the scientist pools, or the
// legacy ones for an older record), or null when its recorded name is shown as it is.
export function workerNameIndex(worker) {
  return resolveWorkerName(worker)?.nameIndex ?? null;
}

// workerDisplayName is the worker's name in lang. A name outside the pools shows as it was.
export function workerDisplayName(worker, lang) {
  const resolved = resolveWorkerName(worker);
  return resolved ? nameAt(poolFor(resolved.pools, lang), resolved.nameIndex) : text(worker?.name);
}

function hash(value) {
  let out = 2166136261;
  for (const char of text(value)) {
    out ^= char.codePointAt(0);
    out = Math.imul(out, 16777619);
  }
  return out >>> 0;
}

// workerAvatarIndex is the worker's logo style. A record without one gets a fixed style from its
// id: "worker-<n>" takes the styles in order, as the runtime numbered them, anything else a hash.
export function workerAvatarIndex(worker) {
  const recorded = index(worker?.avatarIndex ?? worker?.avatar_index);
  if (recorded !== null) {
    return recorded % WORKER_AVATAR_STYLES.length;
  }
  const id = text(worker?.id);
  const numbered = /^worker-([1-9]\d*)$/u.exec(id);
  if (numbered) {
    return (Number(numbered[1]) - 1) % WORKER_AVATAR_STYLES.length;
  }
  return hash(id) % WORKER_AVATAR_STYLES.length;
}

export function workerAvatarStyle(worker) {
  return WORKER_AVATAR_STYLES[workerAvatarIndex(worker)];
}

// readWorkerIndices keeps the recorded indices of a raw or already normalized worker record.
export function readWorkerIndices(raw) {
  const out = {};
  const nameIndex = index(raw?.nameIndex ?? raw?.name_index);
  const avatarIndex = index(raw?.avatarIndex ?? raw?.avatar_index);
  if (nameIndex !== null) out.nameIndex = nameIndex;
  if (avatarIndex !== null) out.avatarIndex = avatarIndex;
  return out;
}
