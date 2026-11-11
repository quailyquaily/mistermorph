// What a worker looks like: its name in the Console's language and its logo style. The runtime
// allocates both at random for each task and records them as a name set and indices (name_set,
// name_index and avatar_index), so a worker keeps the same picks through reloads and resumes, and
// switching the language changes only the name shown. The worker's identity is its id, never its
// name.

// The name sets a user can pick on the Tools page (tools.agent_name_set), in the order offered.
// A task names its workers from the set it started with; scientists are the default, and the only
// set before name sets existed.
export const WORKER_NAME_SETS = Object.freeze(["scientists", "musicians", "artists"]);
export const DEFAULT_WORKER_NAME_SET = "scientists";

// The name pools of each set. Every language names the same person at the same position, in the
// form conventional there (Einstein, 爱因斯坦, アインシュタイン), and every pool has the same size,
// because a name index picks the same position in each. The English pools are the runtime's
// (agent/worker_names.go) and must stay the same lists in the same order. No name is in two
// sets, nor in the legacy pool, so a recorded name tells which pool it came from.

// The scientists.
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

export const MUSICIAN_WORKER_NAME_POOLS = Object.freeze({
  en: Object.freeze([
    "Bach", "Mozart", "Beethoven", "Chopin", "Vivaldi", "Handel", "Haydn", "Schubert",
    "Brahms", "Tchaikovsky", "Verdi", "Puccini", "Debussy", "Ravel", "Liszt", "Mahler",
    "Dvořák", "Grieg", "Sibelius", "Stravinsky", "Gershwin", "Ellington", "Armstrong", "Coltrane",
    "Fitzgerald", "Piaf", "Schumann", "Rachmaninoff", "Satie", "Hildegard", "Boulanger", "Sakamoto",
  ]),
  zh: Object.freeze([
    "巴赫", "莫扎特", "贝多芬", "肖邦", "维瓦尔第", "亨德尔", "海顿", "舒伯特",
    "勃拉姆斯", "柴可夫斯基", "威尔第", "普契尼", "德彪西", "拉威尔", "李斯特", "马勒",
    "德沃夏克", "格里格", "西贝柳斯", "斯特拉文斯基", "格什温", "艾灵顿", "阿姆斯特朗", "柯川",
    "菲茨杰拉德", "琵雅芙", "舒曼", "拉赫玛尼诺夫", "萨蒂", "希尔德加德", "布朗热", "坂本龙一",
  ]),
  ja: Object.freeze([
    "バッハ", "モーツァルト", "ベートーヴェン", "ショパン", "ヴィヴァルディ", "ヘンデル", "ハイドン", "シューベルト",
    "ブラームス", "チャイコフスキー", "ヴェルディ", "プッチーニ", "ドビュッシー", "ラヴェル", "リスト", "マーラー",
    "ドヴォルザーク", "グリーグ", "シベリウス", "ストラヴィンスキー", "ガーシュウィン", "エリントン", "アームストロング", "コルトレーン",
    "フィッツジェラルド", "ピアフ", "シューマン", "ラフマニノフ", "サティ", "ヒルデガルト", "ブーランジェ", "坂本龍一",
  ]),
});

export const ARTIST_WORKER_NAME_POOLS = Object.freeze({
  en: Object.freeze([
    "Leonardo", "Michelangelo", "Raphael", "Rembrandt", "Vermeer", "Van Gogh", "Monet", "Renoir",
    "Cézanne", "Degas", "Picasso", "Matisse", "Kahlo", "Hokusai", "Hiroshige", "Klimt",
    "Dürer", "Botticelli", "Caravaggio", "Goya", "Turner", "O'Keeffe", "Kandinsky", "Mondrian",
    "Magritte", "Dalí", "Miró", "Chagall", "Warhol", "Gentileschi", "Gauguin", "Qi Baishi",
  ]),
  zh: Object.freeze([
    "达·芬奇", "米开朗基罗", "拉斐尔", "伦勃朗", "维米尔", "梵高", "莫奈", "雷诺阿",
    "塞尚", "德加", "毕加索", "马蒂斯", "卡罗", "葛饰北斋", "歌川广重", "克里姆特",
    "丢勒", "波提切利", "卡拉瓦乔", "戈雅", "透纳", "欧姬芙", "康定斯基", "蒙德里安",
    "马格利特", "达利", "米罗", "夏加尔", "沃霍尔", "真蒂莱斯基", "高更", "齐白石",
  ]),
  ja: Object.freeze([
    "ダ・ヴィンチ", "ミケランジェロ", "ラファエロ", "レンブラント", "フェルメール", "ゴッホ", "モネ", "ルノワール",
    "セザンヌ", "ドガ", "ピカソ", "マティス", "カーロ", "北斎", "広重", "クリムト",
    "デューラー", "ボッティチェリ", "カラヴァッジョ", "ゴヤ", "ターナー", "オキーフ", "カンディンスキー", "モンドリアン",
    "マグリット", "ダリ", "ミロ", "シャガール", "ウォーホル", "ジェンティレスキ", "ゴーギャン", "斉白石",
  ]),
});

// The pools of each name set, by its recorded name.
export const WORKER_NAME_SET_POOLS = Object.freeze({
  scientists: WORKER_NAME_POOLS,
  musicians: MUSICIAN_WORKER_NAME_POOLS,
  artists: ARTIST_WORKER_NAME_POOLS,
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

// normalizeWorkerNameSet is the name set value names, or the default for a missing or unknown one
// (the runtime reads tools.agent_name_set the same way).
export function normalizeWorkerNameSet(value) {
  const set = text(value).toLowerCase();
  return WORKER_NAME_SETS.includes(set) ? set : DEFAULT_WORKER_NAME_SET;
}

// workerNamePool is a name set's pool for a Console language (the scientists without a set); a
// language without one uses English.
export function workerNamePool(lang, nameSet = DEFAULT_WORKER_NAME_SET) {
  return poolFor(WORKER_NAME_SET_POOLS[normalizeWorkerNameSet(nameSet)], lang);
}

// workerNameExamples is the first count names of a set in lang, for showing what it is like.
export function workerNameExamples(nameSet, lang, count = 4) {
  return workerNamePool(lang, nameSet).slice(0, count);
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

// recordedNameSet is the name set a record names, lowercased, or "" when it has none.
function recordedNameSet(worker) {
  return text(worker?.nameSet ?? worker?.name_set).toLowerCase();
}

// resolveWorkerName decides which pools and index name a worker, or null to show the recorded name
// as it is. A record with a name set is read in that set only: its index is trusted when the
// recorded name is the one the runtime gives there, or when there is no name; without an index it
// is read back from its English name; a set this Console does not know shows the recorded name.
// Records from before name sets are read in the scientist pools, the legacy ones for older records,
// and, should a set have been lost on the way, any other set whose name at that index is the
// recorded one. A record without a name and set takes its index as a scientist, as it was then.
// Anything else (a name from no pool, or one that does not match its index) is not relabelled; and
// a record is never read in the set the user prefers now.
function resolveWorkerName(worker) {
  const name = text(worker?.name);
  const recorded = index(worker?.nameIndex ?? worker?.name_index);
  const set = recordedNameSet(worker);
  let candidates;
  if (set) {
    if (!Object.hasOwn(WORKER_NAME_SET_POOLS, set)) return null;
    candidates = [WORKER_NAME_SET_POOLS[set]];
  } else {
    candidates = [WORKER_NAME_POOLS, LEGACY_WORKER_NAME_POOLS, MUSICIAN_WORKER_NAME_POOLS, ARTIST_WORKER_NAME_POOLS];
  }
  if (recorded !== null) {
    if (!name) return { pools: candidates[0], nameIndex: recorded };
    const pools = candidates.find((pools) => nameAt(pools.en, recorded) === name);
    return pools ? { pools, nameIndex: recorded } : null;
  }
  for (const pools of candidates) {
    const nameIndex = englishNameIndex(pools, name);
    if (nameIndex !== null) return { pools, nameIndex };
  }
  return null;
}

// workerNameIndex is the index the worker's name is shown from (in its set's pools, or the legacy
// ones for an older record), or null when its recorded name is shown as it is.
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

// readWorkerIndices keeps the recorded name set and indices of a raw or already normalized worker
// record. A set is kept as recorded, even one this Console does not know, so the record keeps
// naming the pool it came from.
export function readWorkerIndices(raw) {
  const out = {};
  const nameSet = recordedNameSet(raw);
  if (nameSet) out.nameSet = nameSet;
  const nameIndex = index(raw?.nameIndex ?? raw?.name_index);
  const avatarIndex = index(raw?.avatarIndex ?? raw?.avatar_index);
  if (nameIndex !== null) out.nameIndex = nameIndex;
  if (avatarIndex !== null) out.avatarIndex = avatarIndex;
  return out;
}
