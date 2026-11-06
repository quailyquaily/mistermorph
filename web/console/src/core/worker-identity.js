// What a worker looks like: its name in the Console's language and its logo style. The runtime
// allocates both at random for each task and records them as indices (name_index and
// avatar_index), so a worker keeps the same picks through reloads and resumes, and switching the
// language changes only the name shown. The worker's identity is its id, never its name.

// The name pools. Each language has its own names, natural there rather than translated, and
// every pool has the same size, because a name index picks the same position in each. The
// English pool is the runtime's (agent/worker.go) and must stay the same list in the same order;
// its first eight are the names given out before names were random.
export const WORKER_NAME_POOLS = Object.freeze({
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

// workerNamePool is the pool for a Console language; a language without one uses English.
export function workerNamePool(lang) {
  const key = text(lang).toLowerCase().split(/[-_]/u)[0];
  return Object.hasOwn(WORKER_NAME_POOLS, key) ? WORKER_NAME_POOLS[key] : WORKER_NAME_POOLS.en;
}

function nameAt(nameIndex, lang) {
  const pool = workerNamePool(lang);
  const round = Math.floor(nameIndex / pool.length);
  const name = pool[nameIndex % pool.length];
  return round > 0 ? `${name}-${round + 1}` : name;
}

// legacyNameIndex reads a name index back from an English name a record without indices
// carries ("Milo", or "Milo-2" for a repeat), so older histories still follow the language. A
// name not in the pool has none.
function legacyNameIndex(name) {
  const match = /^(.+?)(?:-([2-9]|[1-9]\d+))?$/u.exec(text(name));
  if (!match) return null;
  const position = WORKER_NAME_POOLS.en.indexOf(match[1]);
  if (position < 0) return null;
  const round = match[2] ? Number(match[2]) - 1 : 0;
  return round * WORKER_NAME_POOL_SIZE + position;
}

// workerNameIndex is the worker's recorded name index, or the one its legacy name implies.
export function workerNameIndex(worker) {
  return index(worker?.nameIndex ?? worker?.name_index) ?? legacyNameIndex(worker?.name);
}

// workerDisplayName is the worker's name in lang. A legacy name outside the pools shows as it was.
export function workerDisplayName(worker, lang) {
  const nameIndex = workerNameIndex(worker);
  return nameIndex === null ? text(worker?.name) : nameAt(nameIndex, lang);
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
