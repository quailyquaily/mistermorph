// The rename dialog's parts as they lay out (tests/fixtures/topic-rename-dialog-app.tsx): the
// regenerate button is its icon alone, square and as tall as the name field, loading or not, and
// keeps "Regenerate" as its accessible name; Cancel and Save are as wide as each other, on a
// desktop and on a phone.
import { expect, open, test } from "nsh/test";

type Frame = { w: number; h: number };
const PARTS = ["field", "regenerate", "cancel", "save"];

async function openDialog(width: number, platform: "linux" | "android") {
  const app = await open("./fixtures/topic-rename-dialog-app.tsx", { width, height: 800, platform, locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitFor("id:chat-topic-rename-input");
  await app.waitUntil(() => PARTS.every((part) => Boolean(frames()[part])));
  await app.wait(100);
  return { app, frames };
}

for (const item of [
  { name: "a desktop", width: 1280, platform: "linux" as const },
  { name: "an Android phone", width: 390, platform: "android" as const },
]) {
  test(`on ${item.name} Regenerate is a square icon as tall as the field, and Cancel and Save are equally wide`, async () => {
    const { app, frames } = await openDialog(item.width, item.platform);
    const all = frames();
    expect(all.field.h).toBe(44);
    expect(all.regenerate.h).toBe(all.field.h);
    expect(all.regenerate.w).toBe(all.regenerate.h);
    expect(all.cancel.w).toBe(all.save.w);
    expect(all.cancel.h).toBe(all.save.h);
    // The field takes the rest of its row.
    expect(all.field.w).toBeGreaterThan(all.regenerate.w * 4);
    // No visible label, the localized name kept for assistive tech, the hint as its tooltip.
    expect(app.shows("id:chat-topic-rename-regenerate >> text:Regenerate")).toBe(false);
    expect(app.texts().includes("Regenerate")).toBe(false);
    expect(app.shows("label:Regenerate")).toBe(true);
    expect(app.texts().includes("Cancel")).toBe(true);
    expect(app.texts().includes("Save")).toBe(true);

    // Loading: the same box, still no label.
    await app.press("id:fixture-suggest");
    await app.waitFor("id:chat-topic-rename-regenerate-loading");
    await app.wait(100);
    expect(frames().regenerate).toEqual(all.regenerate);
    expect(app.texts().includes("Regenerate")).toBe(false);
    expect(app.shows("label:Regenerate")).toBe(true);
  });
}
