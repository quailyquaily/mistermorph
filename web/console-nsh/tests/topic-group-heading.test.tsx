// A foldable topic group's heading in the topic list (TopicSidebar's group toggle): its caret, tag
// icon, label, count and hairline sit in the middle of its hover fill, open and folded, with as much
// room above them as below.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

async function openGallery() {
  const app = await open("./fixtures/topic-group-heading-app.tsx", { width: 900, height: 900, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitUntil(() => Boolean(frames()["open-hairline"] && frames()["folded-count"]));
  return { app, frames };
}

for (const state of ["open", "folded"]) {
  test(`a ${state} group's heading has its contents in its middle`, async () => {
    const { frames } = await openGallery();
    const toggle = frames()[`${state}-toggle`];
    const label = frames()[`${state}-label`];
    expect(toggle).toBeDefined();
    // The label is the tallest part: as much room above it as below.
    const above = label.y;
    const below = toggle.h - (label.y + label.h);
    expect(Math.abs(above - below)).toBeLessThan(0.5);
    expect(above).toBeGreaterThan(0);
    // The heading keeps its height (the static heading's 10pt above and 4 below, now 7 and 7).
    expect(Math.abs(toggle.h - (label.h + 14))).toBeLessThan(0.5);
    const parts = ["caret", "tag", "label", "hairline", ...(state === "folded" ? ["count"] : [])];
    for (const part of parts) {
      const frame = frames()[`${state}-${part}`];
      expect(frame).toBeDefined();
      expect(Math.abs(frame.y + frame.h / 2 - toggle.h / 2)).toBeLessThan(0.75);
    }
  });
}
