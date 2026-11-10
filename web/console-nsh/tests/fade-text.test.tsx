// FadeText's fade where the platform draws no masks (Android): a cut text's letters under the fade
// are drawn one by one at the mask's alpha, from measured widths (never a count of letters); a text
// that fits, an empty one and every text on the desktops stay one plain text. The topic list's rows
// keep their row, status mark and press with long Chinese and Latin titles on a narrow phone.
// Headless runs measure every letter alike (about 8pt at 14pt), so the look is not checked here.
import { expect, open, test } from "nsh/test";
import { drawnGlyph, maskAlpha, planGlyphFade, platformDrawsMasks, splitGlyphs, type GlyphFadePlan } from "../components/motion/glyphFade";
import { openConsole } from "./harness";

const LATIN = "Plan the quarterly roadmap review with the platform and design teams";
const CHINESE = "整理下季度产品路线图评审会议纪要并同步给平台组和设计组的同事们";

type Plans = Record<string, GlyphFadePlan | null>;

function whole(plan: GlyphFadePlan): string {
  return plan.head + plan.fading.map((letter) => letter.glyph).join("") + plan.rest;
}

function expectFading(plan: GlyphFadePlan) {
  expect(plan.fading.length).toBeGreaterThan(0);
  for (const [i, letter] of plan.fading.entries()) {
    expect(letter.alpha).toBeGreaterThan(0);
    expect(letter.alpha).toBeLessThanOrEqual(1);
    if (i > 0) expect(letter.alpha).toBeLessThan(plan.fading[i - 1].alpha);
  }
}

test("only Android lacks masks", () => {
  expect(platformDrawsMasks("android")).toBe(false);
  for (const os of ["web", "linux", "macos", "windows", "ios"]) expect(platformDrawsMasks(os)).toBe(true);
});

test("letters are split as a reader sees them", () => {
  expect(splitGlyphs("Trip")).toEqual(["T", "r", "i", "p"]);
  expect(splitGlyphs("路线图")).toEqual(["路", "线", "图"]);
  expect(splitGlyphs("")).toEqual([]);
  // A combining accent, a skin tone, a joined family, a flag and a keycap stay with their letter.
  expect(splitGlyphs("éa")).toEqual(["é", "a"]);
  expect(splitGlyphs("👍🏽!")).toEqual(["👍🏽", "!"]);
  expect(splitGlyphs("👩‍👩‍👧x")).toEqual(["👩‍👩‍👧", "x"]);
  expect(splitGlyphs("🇯🇵🇫🇷")).toEqual(["🇯🇵", "🇫🇷"]);
  expect(splitGlyphs("1️⃣")).toEqual(["1️⃣"]);
  // A space alone keeps a space's width.
  expect(drawnGlyph(" ")).toBe(" ");
  expect(drawnGlyph("plan ")).toBe("plan ");
  expect(drawnGlyph("a b")).toBe("a b");
});

test("the mask's alpha runs from whole to none over the fade's length", () => {
  expect(maskAlpha(0, 200, 34)).toBe(1);
  expect(maskAlpha(166, 200, 34)).toBe(1);
  expect(Math.abs(maskAlpha(183, 200, 34) - 0.5)).toBeLessThan(1e-9);
  expect(maskAlpha(200, 200, 34)).toBe(0);
  expect(maskAlpha(240, 200, 34)).toBe(0);
});

test("the fade falls where the measured letters cross the box's last 34pt, Latin or Chinese", () => {
  // Latin letters about 7pt, Chinese ones 14pt: the same box fades five Latin letters, or two or
  // three Chinese ones, never a fixed count.
  const latin = splitGlyphs(LATIN);
  const latinPlan = planGlyphFade(latin, latin.map(() => 7), 200, 34)!;
  expect(whole(latinPlan)).toBe(LATIN);
  expect(latinPlan.head.length * 7).toBeLessThanOrEqual(200 - 34);
  expectFading(latinPlan);
  expect(latinPlan.fading.length).toBeGreaterThanOrEqual(5);
  const chinese = splitGlyphs(CHINESE);
  const chinesePlan = planGlyphFade(chinese, chinese.map(() => 14), 200, 34)!;
  expect(whole(chinesePlan)).toBe(CHINESE);
  expect(Array.from(chinesePlan.head).length * 14).toBeLessThanOrEqual(200 - 34);
  expectFading(chinesePlan);
  expect(chinesePlan.fading.length).toBeLessThanOrEqual(3);
  expect(chinesePlan.fading.length).toBeLessThan(latinPlan.fading.length);
  // Each letter shows at the mask's alpha at its middle.
  const start = Array.from(chinesePlan.head).length * 14;
  chinesePlan.fading.forEach((letter, i) => expect(Math.abs(letter.alpha - maskAlpha(start + i * 14 + 7, 200, 34))).toBeLessThan(0.001));
  // Mixed widths: the letters' own widths place the fade.
  const mixed = splitGlyphs("Roadmap 路线图评审 notes");
  const widths = mixed.map((glyph) => (/[一-鿿]/.test(glyph) ? 14 : 7));
  const mixedPlan = planGlyphFade(mixed, widths, 100, 34)!;
  let x = 0;
  for (const glyph of splitGlyphs(mixedPlan.head)) x += /[一-鿿]/.test(glyph) ? 14 : 7;
  expect(x).toBeLessThanOrEqual(100 - 34);
  expectFading(mixedPlan);
});

test("a box narrower than the fade fades from its start, and unmeasured letters give no plan", () => {
  const glyphs = splitGlyphs(CHINESE);
  const plan = planGlyphFade(glyphs, glyphs.map(() => 14), 20, 34)!;
  expect(plan.head).toBe("");
  expectFading(plan);
  expect(planGlyphFade(glyphs, [14, 14], 200, 34)).toBeNull();
  expect(planGlyphFade(["a"], [Number.NaN], 200, 34)).toBeNull();
});

async function openGallery(platform: "android" | "linux") {
  const app = await open("./fixtures/fade-text-app.tsx", { width: 1300, height: 900, platform, locale: "en-US" });
  const plans = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Plans;
  return { app, plans };
}

test("on Android a cut title fades letter by letter, and one that fits stays whole", async () => {
  const { app, plans } = await openGallery("android");
  await app.waitUntil(() => Boolean(plans().latin && plans().chinese && plans().narrow && plans().live));
  for (const name of ["latin", "chinese", "narrow", "live"]) {
    const plan = plans()[name]!;
    expectFading(plan);
    expect(whole(plan)).toBe(name === "latin" || name === "live" ? LATIN : CHINESE);
  }
  // Nothing hidden: the letters past the fade are laid out (clipped by the row), the label is whole.
  expect(plans().latin!.rest.length).toBeGreaterThan(0);
  expect(app.shows(`label:${LATIN}`)).toBe(true);
  expect(app.shows(`label:${CHINESE}`)).toBe(true);
  expect(plans().narrow!.head).toBe("");
  // A text that fits and an empty one: no fade, one plain text.
  expect(plans().fits ?? null).toBeNull();
  expect(plans().empty ?? null).toBeNull();
  expect(app.texts()).toContain("Trip plans");
  // The marks beside the titles stay.
  for (const name of ["latin", "chinese", "fits", "narrow"]) expect(app.shows(`id:dot-${name}`)).toBe(true);
});

test("on Android the fade follows the box's width and the text", async () => {
  const { app, plans } = await openGallery("android");
  await app.waitUntil(() => Boolean(plans().live));
  const before = plans().live!;
  await app.press("id:widen");
  await app.waitUntil(() => plans().live === null);
  expect(app.texts()).toContain(LATIN);
  await app.press("id:narrow");
  await app.waitUntil(() => Boolean(plans().live));
  expect(plans().live).toEqual(before);
  await app.press("id:short");
  await app.waitUntil(() => plans().live === null);
  expect(app.texts()).toContain("Recipes");
  await app.press("id:chinese");
  await app.waitUntil(() => Boolean(plans().live) && whole(plans().live!) === CHINESE);
  expectFading(plans().live!);
  await app.wait(100);
  expect(whole(plans().live!)).toBe(CHINESE);
});

test("on the desktops the mask fades the text: it stays one text", async () => {
  const { app, plans } = await openGallery("linux");
  await app.wait(100);
  expect(plans()).toEqual({});
  expect(app.texts()).toContain(LATIN);
  expect(app.texts()).toContain(CHINESE);
});

const NOW = new Date().toISOString();
const LONG_LATIN = "Quarterly roadmap review with the platform and design teams, notes and follow-ups";
const LONG_CHINESE = "整理下季度产品路线图评审会议纪要并同步给平台组和设计组的同事们以及后续跟进事项";

test("the phone's topic list keeps rows, marks and presses with long Chinese and Latin titles", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    width: 360,
    location: "/e/default/chat",
    api: {
      "GET /proxy:/topics": {
        body: {
          items: [
            { id: "topic-latin", title: LONG_LATIN, created_at: NOW, updated_at: NOW },
            { id: "topic-chinese", title: LONG_CHINESE, created_at: NOW, updated_at: NOW },
            { id: "topic-short", title: "Recipes", created_at: NOW, updated_at: NOW },
          ],
        },
      },
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/topics/activity": { body: { topics: [{ id: "topic-chinese", status: "running", running: 1 }] } },
    },
  });
  await app.waitFor("id:chat-topic-topic-chinese");
  await app.waitFor("id:chat-topic-status-running");
  // The long titles are drawn in pieces under the fade; the short one is one text.
  await app.waitUntil(() => !app.texts().includes(LONG_LATIN) && !app.texts().includes(LONG_CHINESE));
  expect(app.texts()).toContain("Recipes");
  // A head that ends at a space ends in a no-break space (drawnGlyph), wherever the row's width puts the cut.
  const drawnHeadOf = (title: string) => app.texts().some((text) => text.length > 3 && title.startsWith(text.replace(/\u00a0/g, " ")));
  expect(drawnHeadOf(LONG_CHINESE)).toBe(true);
  expect(drawnHeadOf(LONG_LATIN)).toBe(true);
  // The rows read and press as before.
  expect(app.shows(`label:${LONG_CHINESE}`)).toBe(true);
  await app.press("id:chat-topic-topic-chinese");
  await app.waitUntil(() => calls.some((call) => call.uri?.includes("topic_id=topic-chinese") ?? false));
});
