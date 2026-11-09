// Worker names in a task's roster: scientists in the Console's language, the same scientist at
// each position, a legacy record keeping its ordinary name, and switching back restoring them.
import { expect, open, test } from "nsh/test";

const NAMES = {
  en: ["Noether", "Curie", "Einstein", "Archimedes", "Mendeleev", "Turing", "Hopper", "Ramanujan", "Newton", "Darwin", "Lovelace", "Copernicus", "Darwin-2", "Hazel"],
  zh: ["诺特", "居里", "爱因斯坦", "阿基米德", "门捷列夫", "图灵", "霍珀", "拉马努金", "牛顿", "达尔文", "洛夫莱斯", "哥白尼", "达尔文-2", "胡敏"],
  ja: ["ネーター", "キュリー", "アインシュタイン", "アルキメデス", "メンデレーエフ", "チューリング", "ホッパー", "ラマヌジャン", "ニュートン", "ダーウィン", "ラブレス", "コペルニクス", "ダーウィン-2", "山口凛"],
};

function shown(app: { texts(): string[] }) {
  return app.texts().filter((text) => !["en", "zh", "ja", "fr"].includes(text));
}

test("the roster names workers after scientists in each language, and switching back restores them", async () => {
  const app = await open("./fixtures/chat-worker-names-app.tsx", { width: 400, height: 700, platform: "linux", locale: "en-US" });
  await app.press("id:lang-en");
  await app.waitUntil(() => shown(app).includes("Noether"));
  expect(shown(app)).toEqual(NAMES.en);
  for (const lang of ["zh", "ja", "fr", "en"] as const) {
    await app.press(`id:lang-${lang}`);
    const want = lang === "fr" ? NAMES.en : NAMES[lang];
    await app.waitUntil(() => shown(app)[0] === want[0]);
    expect(shown(app)).toEqual(want);
  }
});

test("the selected worker's panel names it as its chip does, in every language", async () => {
  const app = await open("./fixtures/chat-worker-names-app.tsx", { width: 400, height: 700, platform: "linux", locale: "en-US" });
  await app.press("id:lang-ja");
  await app.waitUntil(() => shown(app)[0] === NAMES.ja[0]);
  await app.press("キュリー");
  await app.waitUntil(() => shown(app).filter((text) => text === "キュリー").length === 2);
  for (const lang of ["zh", "en", "ja"] as const) {
    await app.press(`id:lang-${lang}`);
    const name = NAMES[lang][1];
    await app.waitUntil(() => shown(app).filter((text) => text === name).length === 2);
  }
});
