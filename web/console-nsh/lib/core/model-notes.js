// Notes on popular models for the model picker: a verdict and a one-line note per language.
//
// - match: a model ID pattern, without the vendor prefix ("anthropic/" is ignored). "*" matches
//   anything, case does not matter, and "." and "-" are the same, so "claude-opus-4-7*" also matches
//   OpenRouter's "anthropic/claude-opus-4.7".
// - verdict: "avoid" moves the model to the Others group at the bottom, dimmed (it can still be
//   picked); "recommended" and "ok" keep it in its group, overriding the automatic rules.
//
// Old versions, old models and non-chat models are found automatically (model-legacy.js); list a
// model here only for what those rules cannot know: what it is good for, a verdict on quality, or
// an API name that was retired.
// - note: by language ("en", "zh", "ja"); English is the fallback. Say what the model is for, and
//   for "avoid", why or what to use instead.
//
// The first entry that matches wins, so put specific patterns before general ones.
export const MODEL_NOTES = [


  // Anthropic (models overview, Oct 2026)
  {
    match: "claude-opus-5-5*",
    verdict: "recommended",
    note: {
      en: "Anthropic's suggested default: strong at long agentic coding and knowledge work, and cheaper than Opus 5.",
      zh: "Anthropic 官方推荐的默认款，长时间写代码、干活都很强，还比 Opus 5 便宜。",
      ja: "Anthropic が推奨する既定モデル。長時間のエージェント的コーディングや知的作業に強く、Opus 5 より安価。",
    },
  },
  {
    match: "claude-sonnet-5-5*",
    verdict: "recommended",
    note: {
      en: "Best mix of speed and intelligence, at Sonnet 5's price; a good everyday default.",
      zh: "速度和聪明程度最均衡，价格和 Sonnet 5 一样，日常默认选它。",
      ja: "速度と賢さのバランスが最良で、価格は Sonnet 5 と同じ。普段使いの既定に。",
    },
  },
  {
    match: "claude-fable-5*",
    verdict: "ok",
    note: {
      en: "Anthropic's largest, for the hardest reasoning; slow and pricey, and Opus 5.5 matches it on most work.",
      zh: "Anthropic 最大的模型，专啃最难的推理；又慢又贵，大多数活 Opus 5.5 就够了。",
      ja: "Anthropic 最大のモデルで最難関の推論向け。遅く高価で、大半の作業は Opus 5.5 で足ります。",
    },
  },
  {
    match: "claude-haiku-4-5*",
    verdict: "ok",
    note: {
      en: "Fastest and cheapest Claude, but its knowledge stops in early 2025.",
      zh: "最快最便宜的 Claude，但知识停在 2025 年初。",
      ja: "最速・最安の Claude。ただし知識は 2025 年初めまで。",
    },
  },
  {
    match: "claude-opus-4-7*",
    verdict: "avoid",
    note: {
      en: "Reviewers report it argues with instructions and over-formats; use Opus 5.5.",
      zh: "拉完了，别用",
      ja: "指示に反論しがちで書式過多との評判。Opus 5.5 を使ってください。",
    },
  },

  // OpenAI (developer docs, Oct 2026)
  {
    match: "gpt-6-1-sol*",
    verdict: "recommended",
    note: {
      en: "Near-Astra quality at a lower cost; OpenAI's balanced pick for agent work.",
      zh: "接近 Astra 的水平，价格低不少，OpenAI 里干 agent 活最均衡的选择。",
      ja: "Astra に近い性能をより低価格で。OpenAI でエージェント用途にバランスの良い選択。",
    },
  },
  {
    match: "gpt-6-astra*",
    verdict: "ok",
    note: {
      en: "OpenAI's strongest for hard multi-step work; slow and expensive, overkill for routine tasks.",
      zh: "OpenAI 最强，适合复杂多步骤的活；又慢又贵，日常小活用它是浪费。",
      ja: "OpenAI 最強で複雑な多段階作業向け。遅く高価で、日常作業には過剰。",
    },
  },
  {
    match: "gpt-6*-luna*",
    verdict: "ok",
    note: {
      en: "Fastest and cheapest GPT-6; for focused, high-volume tasks.",
      zh: "最快最便宜的 GPT-6，跑目标明确、量大的活。",
      ja: "最速・最安の GPT-6。明確で大量の作業向け。",
    },
  },

  // Google (Gemini API models, Oct 2026)
  {
    match: "gemini-3-8-flash",
    verdict: "recommended",
    note: {
      en: "Google's newest workhorse, built for long agent and coding tasks; fast and cheap.",
      zh: "Google 最新的主力，专为长时间 agent 和写代码设计，又快又便宜。",
      ja: "Google の最新主力モデル。長時間のエージェント・コーディング向けで、速くて安い。",
    },
  },
  {
    match: "gemini-*flash-lite*",
    verdict: "ok",
    note: {
      en: "Cheapest Gemini; for simple, high-volume tasks.",
      zh: "最便宜的 Gemini，跑简单批量活。",
      ja: "最安の Gemini。簡単な大量処理向け。",
    },
  },
  {
    match: "gemini-3-1-pro*",
    verdict: "ok",
    note: {
      en: "Gemini's Pro model for hard problems, but still a preview and older than 3.8 Flash.",
      zh: "Gemini 的 Pro，适合难题，但还是预览版，比 3.8 Flash 旧。",
      ja: "難問向けの Gemini Pro。ただしまだプレビューで、3.8 Flash より古い。",
    },
  },
  {
    match: "gemini-3-pro*",
    verdict: "avoid",
    note: {
      en: "Shut down; use Gemini 3.8 Flash or 3.1 Pro.",
      zh: "已经下线了，用 3.8 Flash 或 3.1 Pro。",
      ja: "提供終了。3.8 Flash か 3.1 Pro を使ってください。",
    },
  },

  // xAI (models docs, Oct 2026)
  {
    match: "grok-4-7*",
    verdict: "recommended",
    note: {
      en: "xAI's most capable model, for code, chat and agents; well priced.",
      zh: "xAI 最强的模型，写代码、聊天、agent 都行，价格也合理。",
      ja: "xAI で最も高性能。コード・会話・エージェント向けで、価格も手頃。",
    },
  },
  {
    match: "grok-4-3*",
    verdict: "ok",
    note: {
      en: "Cheaper than Grok 4.7, with a 1M context window.",
      zh: "比 4.7 便宜，上下文 1M。",
      ja: "Grok 4.7 より安く、1M コンテキスト。",
    },
  },
  {
    match: "grok-build*",
    verdict: "ok",
    note: {
      en: "Lightweight and cheap.",
      zh: "轻量便宜。",
      ja: "軽量で安価。",
    },
  },
  {
    match: "grok-4-20*",
    verdict: "ok",
    note: {
      en: "Older variant split into reasoning and non-reasoning; prefer Grok 4.7.",
      zh: "老变体，分推理/非推理版，优先用 4.7。",
      ja: "推論/非推論に分かれた旧版。Grok 4.7 を優先。",
    },
  },

  // DeepSeek (API pricing, Oct 2026)
  {
    match: "deepseek-v4-pro*",
    verdict: "recommended",
    note: {
      en: "Best price-to-performance for coding, with open weights; prices double at peak hours.",
      zh: "写代码性价比之王，还开源；高峰时段价格翻倍。",
      ja: "コーディングのコスパ最良で、オープンウェイト。ピーク時間帯は料金が倍。",
    },
  },
  {
    match: "deepseek-flash*",
    verdict: "ok",
    note: {
      en: "Nearly free; good for simple and high-volume work.",
      zh: "几乎白送，简单活、量大的活随便用。",
      ja: "ほぼ無料。簡単な大量作業向け。",
    },
  },
  {
    match: "deepseek-v4-flash*",
    verdict: "avoid",
    note: {
      en: "Old API name; use deepseek-v4-pro or deepseek-flash.",
      zh: "老的 API 名字了，用 deepseek-v4-pro 或 deepseek-flash。",
      ja: "古い API 名。deepseek-v4-pro か deepseek-flash を。",
    },
  },
  {
    match: "deepseek-chat*",
    verdict: "avoid",
    note: {
      en: "Old API name; use deepseek-v4-pro or deepseek-flash.",
      zh: "老的 API 名字了，用 deepseek-v4-pro 或 deepseek-flash。",
      ja: "古い API 名。deepseek-v4-pro か deepseek-flash を。",
    },
  },
  {
    match: "deepseek-reasoner*",
    verdict: "avoid",
    note: {
      en: "Old API name; use deepseek-v4-pro or deepseek-flash.",
      zh: "老的 API 名字了，用 deepseek-v4-pro 或 deepseek-flash。",
      ja: "古い API 名。deepseek-v4-pro か deepseek-flash を。",
    },
  },

  // Open-weight models (2026 comparison write-ups)
  {
    match: "kimi-k3*",
    verdict: "recommended",
    note: {
      en: "Leading open-weight model; especially strong at frontend code.",
      zh: "开源模型里的领头羊，写前端尤其强。",
      ja: "オープンウェイトの筆頭。特にフロントエンドのコードに強い。",
    },
  },
  {
    match: "glm-5*",
    verdict: "ok",
    note: {
      en: "Open weights (MIT) with strong reasoning; great value.",
      zh: "开源（MIT），推理强，性价比高。",
      ja: "オープンウェイト（MIT）で推論に強く、コスパ良好。",
    },
  },
  {
    match: "qwen3*",
    verdict: "ok",
    note: {
      en: "Open-weight family; the newer ones code well for their size and run locally.",
      zh: "开源系列，新版本以小博大，写代码不错，还能本地跑。",
      ja: "オープンウェイト。新しい版はサイズの割にコーディングが得意で、ローカルでも動く。",
    },
  },
];

const VERDICTS = new Set(["recommended", "ok", "avoid"]);

function normalizeModelID(value) {
  const text = String(value || "").trim().toLowerCase();
  const slash = text.lastIndexOf("/");
  return (slash >= 0 ? text.slice(slash + 1) : text).replace(/\./g, "-");
}

function patternRegExp(pattern) {
  const body = normalizeModelID(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

function noteText(note, locale) {
  if (typeof note === "string") {
    return note.trim();
  }
  if (!note || typeof note !== "object") {
    return "";
  }
  const lang = String(locale || "en").toLowerCase().split(/[-_]/)[0];
  return String(note[lang] || note.en || "").trim();
}

// The verdict and note for a model ID, or null when no entry matches.
export function modelNoteFor(id, locale = "en", notes = MODEL_NOTES) {
  const model = normalizeModelID(id);
  if (!model) {
    return null;
  }
  for (const entry of Array.isArray(notes) ? notes : []) {
    if (!entry?.match || !patternRegExp(entry.match).test(model)) {
      continue;
    }
    const verdict = VERDICTS.has(entry.verdict) ? entry.verdict : "ok";
    return { verdict, note: noteText(entry.note, locale) };
  }
  return null;
}
