// The time above a reply and the progress beside it (ChatStatusMark, ChatStatusCard): on a reply's
// summary line the time or duration is centred with the plan, activity and reasoning columns,
// whatever the reply's state; alone it keeps to its side, a sent message's at the right.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

async function openGallery() {
  const app = await open("./fixtures/chat-status-line-app.tsx", { width: 900, height: 900, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitUntil(() => Boolean(frames()["sent-mark"] && frames()["running-mark"]));
  return { app, frames };
}

for (const line of ["running", "done", "failed", "reasoning"]) {
  test(`a ${line} reply's time is centred with its progress`, async () => {
    const { frames } = await openGallery();
    const card = frames()[`${line}-card`];
    const mark = frames()[`${line}-mark`];
    expect(card).toBeDefined();
    expect(mark).toBeDefined();
    // The time is no taller than the columns (both a 20pt box, design/ui-refresh.html §3): the
    // line is as tall as they are (panels closed), and the time's middle is the line's.
    expect(mark.h).toBeLessThanOrEqual(card.h);
    expect(Math.abs(mark.y + mark.h / 2 - card.h / 2)).toBeLessThan(0.75);
    expect(mark.x).toBe(0);
  });
}

test("a reply with no time still shows its progress", async () => {
  const { app, frames } = await openGallery();
  expect(frames()["timeless-mark"]).toBeUndefined();
  expect(app.shows("id:line-timeless >> id:chat-status-plan")).toBe(true);
  expect(app.count("id:line-timeless >> id:chat-history-status")).toBe(0);
});

test("alone, a reply's time keeps to the left and a sent message's to the right", async () => {
  const { frames } = await openGallery();
  const reply = frames()["reply-mark"];
  const sent = frames()["sent-mark"];
  const column = frames()["sent-column"];
  expect(reply.x).toBe(0);
  expect(reply.w).toBeLessThan(frames()["reply-column"].w);
  expect(sent.w).toBeLessThan(column.w);
  // A sent message's time ends on its bubble's text edge: 8pt inset, 1pt border, 14pt padding.
  expect(Math.abs(sent.x + sent.w + 23 - column.w)).toBeLessThan(0.75);
});
