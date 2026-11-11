// The page host's lifecycle (components/frame/PageStack.tsx), on tests/fixtures/page-stack-app.tsx:
// its slide driver holds each slide until "finish", so both pages can be seen during one. The
// outgoing page stays mounted and inert with its own route until the slide ends; a new navigation
// drops an obsolete outgoing page at once; a resize ends a slide; reduced motion never slides;
// the same page with other data does not move; wide windows keep the entrance.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

async function openStack(options: { reducedMotion?: boolean } = {}) {
  return open("./fixtures/page-stack-app.tsx", {
    width: 390,
    height: 700,
    locale: "en-US",
    platform: "android",
    reducedMotion: options.reducedMotion ?? false,
  });
}

const routeText = (app: App, page: string) => app.texts().find((text) => text.startsWith(`${page}:`)) ?? "";
const plays = (app: App) => app.texts().find((text) => /^-?\d+>/.test(text)) ?? "";

test("the first page arrives without motion", async () => {
  const app = await openStack();
  await app.waitFor("id:fixture-page.a");
  expect(app.count("id:page-layer.in.none")).toBe(1);
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(plays(app)).toBe("");
});

test("forward: the new page slides in from the right over the old one, which stays mounted with its own route until the slide ends", async () => {
  const app = await openStack();
  await app.waitFor("id:fixture-page.a");
  await app.press("id:go-b-forward");
  await app.waitFor("id:fixture-page.b");
  // Both pages during the slide: the old one inert, its route its own.
  expect(app.count("id:page-layer.in.push")).toBe(1);
  expect(app.count("id:page-layer-out")).toBe(1);
  expect(routeText(app, "a")).toBe("a:/a:1");
  expect(routeText(app, "b")).toBe("b:/b:1");
  // The new page from the right edge to its place; the old one drifts a third to the left.
  expect(plays(app)).toBe("390>0 0>-117");

  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  expect(app.count("id:fixture-page.a")).toBe(0);
  expect(app.count("id:page-layer.in.push")).toBe(1);
});

test("back: the leaving page slides out to the right over the page it reveals", async () => {
  const app = await openStack();
  await app.press("id:go-b-forward");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  await app.press("id:go-a-back");
  await app.waitFor("id:fixture-page.a");
  expect(app.count("id:page-layer.in.pop")).toBe(1);
  expect(app.count("id:page-layer-out")).toBe(1);
  expect(plays(app)).toBe("390>0 0>-117 -117>0 0>390");
  // The page going out still shows its own route, not the one coming in.
  expect(routeText(app, "b")).toBe("b:/b:1");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  expect(app.count("id:fixture-page.b")).toBe(0);
});

test("navigation's pages move together as tiles, in either direction", async () => {
  const app = await openStack();
  await app.press("id:go-c-tab");
  await app.waitFor("id:fixture-page.c");
  expect(app.count("id:page-layer.in.tab-forward")).toBe(1);
  expect(plays(app)).toBe("390>0 0>-390");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  await app.press("id:go-a-tab");
  await app.waitFor("id:fixture-page.a");
  expect(app.count("id:page-layer.in.tab-back")).toBe(1);
  expect(plays(app)).toBe("390>0 0>-390 -390>0 0>390");
});

test("a navigation during a slide drops the obsolete outgoing page at once", async () => {
  const app = await openStack();
  await app.press("id:go-b-forward");
  expect(app.count("id:page-layer-out")).toBe(1);
  // While a → b slides, c: a goes at once, b goes out, c comes in.
  await app.press("id:go-c-forward");
  await app.waitFor("id:fixture-page.c");
  expect(app.count("id:fixture-page.a")).toBe(0);
  expect(app.count("id:page-layer-out")).toBe(1);
  expect(app.count("id:fixture-page.b")).toBe(1);
  expect(routeText(app, "b")).toBe("b:/b:1");
  // Back to a while b → c slides: b goes, c goes out, a new a comes in (never the old one).
  await app.press("id:go-a-back");
  await app.waitFor("id:fixture-page.a");
  expect(app.count("id:fixture-page.b")).toBe(0);
  expect(app.count("id:page-layer-out")).toBe(1);
  expect(routeText(app, "a")).toBe("a:/a:1");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  expect(app.count("id:fixture-page.c")).toBe(0);
  expect(app.count("id:fixture-page.a")).toBe(1);
  // The slides that ended early leave nothing behind: one page, in place.
  expect(app.count("id:page-layer.in.pop")).toBe(1);
});

test("a resize or rotation ends a running slide where it ends", async () => {
  const app = await openStack();
  await app.press("id:go-b-forward");
  expect(app.count("id:page-layer-out")).toBe(1);
  await app.setViewport(700, 390);
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  expect(app.count("id:fixture-page.a")).toBe(0);
  expect(app.count("id:fixture-page.b")).toBe(1);
});

test("the same page with other data stays put: no slide, no new page", async () => {
  const app = await openStack();
  await app.press("id:go-b-forward");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:page-layer-out") === 0);
  await app.press("id:go-b2-none");
  await app.waitUntil(() => routeText(app, "b") === "b:/b/2:2");
  // A forward motion within the same page is the page's own to draw (PaneStack): the host keeps it.
  await app.press("id:go-b3-forward");
  await app.waitUntil(() => routeText(app, "b") === "b:/b/3:3");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(plays(app)).toBe("390>0 0>-117");
});

test("reduced motion switches pages at once", async () => {
  const app = await openStack({ reducedMotion: true });
  await app.press("id:go-b-forward");
  await app.waitFor("id:fixture-page.b");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(app.count("id:fixture-page.a")).toBe(0);
  expect(app.count("id:page-layer.in.none")).toBe(1);
  await app.press("id:go-c-tab");
  await app.waitFor("id:fixture-page.c");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(plays(app)).toBe("");
});

test("wide windows keep the entrance: the new page rises, the old one goes at once", async () => {
  const app = await openStack();
  await app.press("id:wide");
  await app.press("id:go-c-tab");
  await app.waitFor("id:fixture-page.c");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(app.count("id:fixture-page.a")).toBe(0);
  expect(app.count("id:page-layer.in.rise")).toBe(1);
  expect(plays(app)).toBe("");
});
