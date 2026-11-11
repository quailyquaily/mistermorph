// A page's own levels on phones (components/motion/PaneStack.tsx), on tests/fixtures/pane-stack-app.tsx:
// the slides of a list and its item within one page instance (Chat's topics, Settings' sections,
// Memories, Audit, Skills, TODO, Contacts, the context inspector's steps). The fixture's driver
// holds each slide until "finish".
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

async function openPanes(options: { reducedMotion?: boolean } = {}) {
  return open("./fixtures/pane-stack-app.tsx", {
    width: 390,
    height: 700,
    locale: "en-US",
    platform: "android",
    reducedMotion: options.reducedMotion ?? false,
  });
}

const read = (app: App, prefix: string) => (app.texts().find((text) => text.startsWith(prefix)) ?? "").slice(prefix.length);

test("further in slides the item in from the right; the list stays until the slide ends, inert", async () => {
  const app = await openPanes();
  await app.press("id:open");
  expect(app.count("id:pane.1")).toBe(1);
  expect(app.count("id:pane.0.out")).toBe(1);
  expect(read(app, "plays=")).toBe("390>0 0>-117");
  expect(read(app, "item=")).toBe("Item 7");
  // The list going out is the one that was there, not a new copy.
  expect(read(app, "mounts=")).toBe("1,1,0");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.0.out") === 0);
  expect(app.count("id:pane.0")).toBe(0);
  expect(read(app, "mounts=")).toBe("1,1,0");
});

test("back slides the item out to the right over the list, still showing its item", async () => {
  const app = await openPanes();
  await app.press("id:open");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.0.out") === 0);
  await app.press("id:wait");
  expect(read(app, "settled=")).toBe("1");

  await app.press("id:back");
  // The item cleared with the change, yet the pane going out holds what it showed.
  expect(app.count("id:pane.1.out")).toBe(1);
  expect(app.count("id:pane.0")).toBe(1);
  expect(read(app, "item=")).toBe("Item 7");
  expect(read(app, "plays=")).toBe("390>0 0>-117 -117>0 0>390");
  await app.press("id:wait");
  expect(read(app, "settled=")).toBe("1");
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.1.out") === 0);
  expect(app.count("id:pane.1")).toBe(0);
  // Whoever waited for the pane to go hears it now.
  await app.waitUntil(() => read(app, "settled=") === "2");
});

test("a deeper level and back up again slide the same ways", async () => {
  const app = await openPanes();
  await app.press("id:open");
  await app.press("id:finish");
  await app.press("id:deeper");
  expect(app.count("id:pane.1.out")).toBe(1);
  expect(app.count("id:pane.2")).toBe(1);
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.1.out") === 0);
  await app.press("id:up");
  expect(app.count("id:pane.2.out")).toBe(1);
  expect(read(app, "plays=")).toBe("390>0 0>-117 390>0 0>-117 -117>0 0>390");
});

test("a change during a slide ends it at once and starts its own", async () => {
  const app = await openPanes();
  await app.press("id:open");
  expect(app.count("id:pane.0.out")).toBe(1);
  await app.press("id:back");
  // The list was going out; now the item is, and the list is the one wanted: no pane left behind.
  expect(app.count("id:pane.0.out")).toBe(0);
  expect(app.count("id:pane.1.out")).toBe(1);
  expect(app.count("id:pane.0")).toBe(1);
  await app.press("id:finish");
  await app.waitUntil(() => app.count("id:pane.1.out") === 0);
  expect(app.count("id:pane.1")).toBe(0);
});

test("a resize ends a running slide; wide windows show the panes side by side with no motion", async () => {
  const app = await openPanes();
  await app.press("id:open");
  expect(app.count("id:pane.0.out")).toBe(1);
  await app.setViewport(700, 390);
  await app.waitUntil(() => app.count("id:pane.0.out") === 0);
  expect(app.count("id:pane.0")).toBe(0);
  await app.press("id:wide");
  expect(app.count("id:pane.0")).toBe(1);
  expect(app.count("id:pane.1")).toBe(1);
  expect(read(app, "plays=")).toBe("390>0 0>-117");
});

test("reduced motion switches levels at once", async () => {
  const app = await openPanes({ reducedMotion: true });
  await app.press("id:open");
  expect(app.count("id:pane.0")).toBe(0);
  expect(app.count("id:pane.1")).toBe(1);
  await app.press("id:back");
  expect(app.count("id:pane.1")).toBe(0);
  expect(read(app, "plays=")).toBe("");
});

test("a level the page arrives with switches at once: no slide while the page arrives", async () => {
  const app = await openPanes();
  await app.press("id:arrive");
  // An address naming the item, opened as the page mounts.
  await app.press("id:open");
  expect(app.count("id:pane.0")).toBe(0);
  expect(app.count("id:pane.1")).toBe(1);
  expect(read(app, "plays=")).toBe("");
});
