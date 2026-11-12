// SecretInput's boxes are the height of a regular field (TextField) and line up with it, stored,
// typing (fresh or replacing), taken from a variable or picked from another field; and their buttons
// stay inside the box, at a phone's width and a desktop's, with the longest storage tags and in
// Japanese. The fixture is the /secret-layout gallery of tests/fixtures/settings-fields-app.tsx;
// what the buttons do is in tests/settings-fields-secret.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openFixture, out } from "./fixtures/settings-fields-open";

type Frame = { x: number; y: number; w: number; h: number };

// The fields that reference a key elsewhere may swap it: another field shares it.
const KEYS = {
  keys: [
    { id: "k1", kind: "env", hint: "sk-…a1b2", ref: "${OPENAI_KEY}", used_by: ["llm.api_key"] },
    { id: "k2", kind: "file", hint: "sk-…c3d4", reveal_path: "llm.api_key", used_by: ["llm.api_key"] },
  ],
  fields: {
    "llm.profiles.ops.api_key": { kind: "os", shared: true },
    "llm.profiles.ops.fallback_api_key": { kind: "env", shared: true, env_name: "MISTER_MORPH_LLM_PROFILES_OPERATIONS_FALLBACK_API_KEY" },
  },
};

// The longest name a system store has: "Windows Credential Manager".
const INFO = { reveal: true, password_required: false, store: "windows_credential_manager" };

const WIDTHS = [
  { name: "a narrow phone", width: 320 },
  { name: "a desktop", width: 1100 },
];

async function openLayout(width: number, options: { language?: string; info?: object } = {}) {
  const { app } = await openFixture(
    "/secret-layout",
    {
      "GET /secrets/info": { body: options.info ?? INFO },
      "GET /secrets/keys": { body: KEYS },
      "POST /secrets/reveal": { body: { value: "123:abc" } },
    },
    { width, height: 1400, language: options.language },
  );
  return app;
}

const frames = (app: App) => JSON.parse(out(app, "frames") || "{}") as Record<string, Frame>;

async function framesWith(app: App, names: string[]) {
  await app.waitUntil(() => names.every((name) => Boolean(frames(app)[name])));
  // Let a second layout pass (fonts, the tag's store name) report too.
  await app.wait(100);
  return frames(app);
}

const right = (frame: Frame) => frame.x + frame.w;
const bottom = (frame: Frame) => frame.y + frame.h;

/** `inner` lies inside `outer`, `inset` in from each side (the box's 1pt border). */
function expectInside(inner: Frame, outer: Frame, what: string, inset = 0) {
  const where = `${what}: ${JSON.stringify(inner)} in ${JSON.stringify(outer)}`;
  expect({ where, ok: inner.x >= outer.x + inset - 0.5 }).toEqual({ where, ok: true });
  expect({ where, ok: right(inner) <= right(outer) - inset + 0.5 }).toEqual({ where, ok: true });
  expect({ where, ok: inner.y >= outer.y + inset - 0.5 }).toEqual({ where, ok: true });
  expect({ where, ok: bottom(inner) <= bottom(outer) - inset + 0.5 }).toEqual({ where, ok: true });
}

/** A field box the regular field's height, at its start and as wide. */
function expectLikeBaseline(field: Frame, all: Record<string, Frame>, what: string) {
  const baseline = all["page.baseline"];
  expect({ what, h: Math.round(field.h) }).toEqual({ what, h: Math.round(baseline.h) });
  expect({ what, x: Math.round(field.x), w: Math.round(field.w) }).toEqual({ what, x: Math.round(baseline.x), w: Math.round(baseline.w) });
}

/** The row of buttons and each of them inside the box, square, side by side, none on another. */
function expectButtonsInside(all: Record<string, Frame>, prefix: string, buttons: string[], box: Frame) {
  const row = all[`${prefix}.actions`];
  expectInside(row, box, `${prefix}.actions`, 1);
  let last: Frame | null = null;
  for (const name of buttons) {
    const button = all[`${prefix}.actions.${name}`];
    expect({ name, w: Math.round(button.w), h: Math.round(button.h) }).toEqual({ name, w: 32, h: 32 });
    expectInside(button, box, `${prefix}.actions.${name}`, 1);
    // Centred in the box.
    expect({ name, off: Math.abs(button.y + button.h / 2 - (box.y + box.h / 2)) <= 0.5 }).toEqual({ name, off: true });
    if (last) expect({ name, after: button.x >= right(last) - 0.5 }).toEqual({ name, after: true });
    last = button;
  }
}

/** The kept-elsewhere tag inside the box and before its buttons. */
function expectTagBeforeButtons(all: Record<string, Frame>, prefix: string, box: Frame) {
  const tag = all[`${prefix}.tag`];
  expectInside(tag, box, `${prefix}.tag`, 1);
  expect({ prefix, before: right(tag) <= all[`${prefix}.actions`].x + 0.5 }).toEqual({ prefix, before: true });
}

/** Room is kept before the tag for a few dots of the mask (border, 12pt padding, 48pt, 10pt gap). */
function expectMaskRoom(all: Record<string, Frame>, prefix: string, box: Frame) {
  const room = all[`${prefix}.tag`].x - box.x;
  expect({ prefix, room: room >= 1 + 12 + 48 + 10 - 0.5 }).toEqual({ prefix, room: true });
}

for (const item of WIDTHS) {
  test(`on ${item.name} stored, fresh and variable secrets are a regular field's height with their buttons inside`, async () => {
    const app = await openLayout(item.width);
    const all = await framesWith(app, [
      "page.baseline",
      "page.env-field",
      "stored.stored.actions.replace",
      "os.stored.actions.replace",
      "os.stored.tag",
      "fresh.typing.actions.picker",
      "env.env.actions.picker",
    ]);
    // The regular field: 44pt (TextField md), as wide as the column.
    expect(Math.round(all["page.baseline"].h)).toBe(44);
    expect(Math.round(all["page.baseline"].w)).toBe(Math.round(all["page.column"].w));

    for (const field of ["stored", "os"]) {
      const box = all[`${field}.stored.field`];
      expectLikeBaseline(box, all, `${field}.stored.field`);
      expectButtonsInside(all, `${field}.stored`, ["reveal", "picker", "replace"], box);
      expectTagBeforeButtons(all, `${field}.stored`, box);
      expectMaskRoom(all, `${field}.stored`, box);
    }
    const fresh = all["fresh.typing.field"];
    expectLikeBaseline(fresh, all, "fresh.typing.field");
    expectButtonsInside(all, "fresh.typing", ["reveal", "picker"], fresh);

    const env = all["env.env.field"];
    expectLikeBaseline(env, all, "env.env.field");
    expectButtonsInside(all, "env.env", ["picker"], env);
    expectLikeBaseline(all["page.env-field"], all, "page.env-field");
  });

  test(`on ${item.name} Replace opens a focused field as tall as the stored one, with clear, eye, key and undo inside`, async () => {
    const app = await openLayout(item.width);
    await framesWith(app, ["page.baseline", "stored.stored.actions.replace"]);
    await app.press("id:layout-stored >> label:Replace");
    await app.waitFor("id:layout-stored-input");
    // The empty field has the focus: keys go into it.
    await app.keyboard.press("s");
    await app.keyboard.press("k");
    await app.waitUntil(() => out(app, "layout-stored") === "sk");
    // Populated: the clear button joins the eye, the key and undo.
    await app.waitFor("id:layout-stored-input-clear");
    const all = await framesWith(app, ["stored.typing.actions.undo", "stored.typing.field"]);
    const box = all["stored.typing.field"];
    expectLikeBaseline(box, all, "stored.typing.field");
    expectButtonsInside(all, "stored.typing", ["reveal", "picker", "undo"], box);
    // Room is left before them for the typed text and the clear button (32pt, 5pt in, 8pt gap).
    expect(all["stored.typing.actions"].x - box.x).toBeGreaterThan(12 + 8 + 32 + 5 + 8 + 40);
    // The eye shows what is typed, and the buttons stay where they are.
    await app.press("id:layout-stored >> label:Show");
    await app.waitFor("id:layout-stored >> label:Hide");
    const shown = await framesWith(app, ["stored.typing.actions.undo"]);
    expectButtonsInside(shown, "stored.typing", ["reveal", "picker", "undo"], shown["stored.typing.field"]);
    // Undo keeps the current key: the stored box again, same height.
    await app.press("id:layout-stored >> label:Keep current");
    await app.waitUntil(() => out(app, "layout-stored") === "");
    await app.waitFor("id:layout-stored >> label:Replace");
    const back = await framesWith(app, ["stored.stored.field"]);
    expectLikeBaseline(back["stored.stored.field"], back, "stored.stored.field after undo");
  });

  test(`on ${item.name} a picked key shows in a regular-height box with undo inside`, async () => {
    const app = await openLayout(item.width);
    await framesWith(app, ["page.baseline", "fresh.typing.actions.picker"]);
    // A variable's reference: the locked variable box.
    await app.press("id:layout-fresh >> label:Use a saved key");
    await app.waitFor("text:sk-…a1b2");
    await app.press("text:sk-…a1b2");
    await app.waitUntil(() => out(app, "layout-fresh") === "${OPENAI_KEY}");
    let all = await framesWith(app, ["fresh.env.actions.undo", "fresh.env.field"]);
    expectLikeBaseline(all["fresh.env.field"], all, "fresh.env.field");
    expectButtonsInside(all, "fresh.env", ["undo"], all["fresh.env.field"]);
    await app.press("id:layout-fresh >> label:Don't use this key");
    await app.waitUntil(() => out(app, "layout-fresh") === "");
    // A plain-text key: its hint and where it came from, a tag that is cut short when long.
    await app.press("id:layout-fresh >> label:Use a saved key");
    await app.waitFor("text:sk-…c3d4");
    await app.press("text:sk-…c3d4");
    await app.waitUntil(() => out(app, "layout-fresh") === "123:abc");
    all = await framesWith(app, ["fresh.picked.actions.undo", "fresh.picked.tag"]);
    const box = all["fresh.picked.field"];
    expectLikeBaseline(box, all, "fresh.picked.field");
    expectButtonsInside(all, "fresh.picked", ["undo"], box);
    expectTagBeforeButtons(all, "fresh.picked", box);
  });
}

test("in Japanese on a narrow phone the long store tag is cut short and every button stays inside", async () => {
  const app = await openLayout(320, { language: "ja" });
  const all = await framesWith(app, ["page.baseline", "os.stored.actions.replace", "os.stored.tag"]);
  expect(app.texts().some((text) => text.includes("資格情報マネージャー"))).toBe(true);
  const box = all["os.stored.field"];
  expectLikeBaseline(box, all, "os.stored.field");
  expectButtonsInside(all, "os.stored", ["reveal", "picker", "replace"], box);
  expectTagBeforeButtons(all, "os.stored", box);
  expectMaskRoom(all, "os.stored", box);
  // The tag gives way to the buttons rather than its full width.
  expect(all["os.stored.tag"].w).toBeLessThan(box.w - 3 * 32);
});

for (const item of [...WIDTHS.map((w) => ({ ...w, language: "en" })), { name: "a narrow phone in Japanese", width: 320, language: "ja" }]) {
  test(`on ${item.name} the console password ask keeps its field and buttons in the column`, async () => {
    const app = await openLayout(item.width, { language: item.language, info: { ...INFO, password_required: true } });
    const start = await framesWith(app, ["page.baseline", "stored.stored.actions.reveal"]);
    await app.press(`id:layout-stored >> label:${item.language === "ja" ? "表示" : "Show"}`);
    await app.waitFor("id:layout-stored-password");
    const all = await framesWith(app, ["stored.ask.field", "stored.ask.actions.submit", "stored.ask.actions.cancel"]);
    const row = all["stored.ask.field"];
    expectInside(row, start["page.column"], "stored.ask.field");
    const submit = all["stored.ask.actions.submit"];
    const cancel = all["stored.ask.actions.cancel"];
    expectInside(submit, row, "submit");
    expectInside(cancel, row, "cancel");
    expect(cancel.x).toBeGreaterThanOrEqual(right(submit) - 0.5);
    // The field takes the row's start, a regular field's height; the buttons beside it or below.
    expect(row.h).toBeGreaterThanOrEqual(43.5);
    // Escape cancels, and the stored box comes back as it was.
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:layout-stored-password"));
    const back = await framesWith(app, ["stored.stored.field"]);
    expectLikeBaseline(back["stored.stored.field"], back, "stored.stored.field after cancel");
  });
}
