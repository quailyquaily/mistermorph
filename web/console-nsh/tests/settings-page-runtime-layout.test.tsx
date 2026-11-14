// Settings › Runtime: the channels card holds all it shows, closed and with the unconfigured
// channels opened, on desktops and phones, beside the model card or stacked under it: nothing
// draws past its edges or under the next card. On phones the stacked cards used to share the
// column's height (flex-1 in a column), so the channels card was shorter than its lines and the
// opened list ran over the runtime metrics. Frames come from tests/fixtures/runtime-panel-app.tsx.
import type { App, StubRequest, StubResponse } from "nsh/test";
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

const OVERVIEW = {
  health: "ok",
  mode: "console",
  agent_name: "Morph",
  llm: { provider: "openai", model: "gpt-5.2" },
  channel: {
    telegram_configured: true,
    telegram_running: true,
    x_configured: true,
    x_running: true,
    x_status: "reauth_needed",
    discord_configured: true,
    discord_running: false,
  },
  running_tasks: { console: 12, cli: 0, telegram: 3 },
  runtime: { go_version: "go1.25" },
};

const UNCONFIGURED = ["slack", "line", "lark", "mixin", "wechat", "whatsapp", "bluesky"];

async function openPanel(width: number, language = "en") {
  const app = await open("./fixtures/runtime-panel-app.tsx", {
    width,
    height: 2000,
    platform: "linux",
    locale: "en-US",
    host: {
      handlers: {
        "morph.boot": {
          runtime: "web",
          origin: "http://console.test",
          basePath: "/",
          location: "/",
          kv: { "quail-language": language },
          session: {},
          languages: ["en-US"],
          desktopVersion: "",
          features: [],
        },
        "morph.kv.set": null,
      },
    },
    network: Object.fromEntries(["GET", "POST"].map((method) => [`${method} *`, answer])),
  });
  return app;

  function answer(raw: StubRequest): StubResponse {
    const url = new URL(raw.url);
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/endpoints") {
      return { body: { items: [{ endpoint_ref: "ep_console_local", name: "Console", url: "in-process://console-local", connected: true, mode: "console" }] } };
    }
    if (path === "/proxy" && url.searchParams.get("uri") === "/overview") return { body: OVERVIEW };
    return { status: 404, body: { error: `no stub for ${path}` } };
  }
}

function frames(app: App): Record<string, Frame> {
  const text = app.texts().find((item) => item.startsWith("{")) ?? "{}";
  return JSON.parse(text);
}

/** `inner` lies within `outer` (to a hair: frames are in points with fractions). */
function expectInside(inner: Frame, outer: Frame, what: string) {
  const at = `${what}: ${JSON.stringify(inner)} in ${JSON.stringify(outer)}`;
  expect({ at, ok: inner.x >= outer.x - 0.5 }).toEqual({ at, ok: true });
  expect({ at, ok: inner.y >= outer.y - 0.5 }).toEqual({ at, ok: true });
  expect({ at, ok: inner.x + inner.w <= outer.x + outer.w + 0.5 }).toEqual({ at, ok: true });
  expect({ at, ok: inner.y + inner.h <= outer.y + outer.h + 0.5 }).toEqual({ at, ok: true });
}

/** Every line of the channels card in it, the card on the page and above the metrics card. */
function expectContained(app: App, width: number, opened: boolean) {
  const all = frames(app);
  const card = all.channels;
  const parts = ["entry-console", "entry-cli", "entry-telegram", "entry-discord", "entry-x"];
  if (opened) parts.push(...UNCONFIGURED.map((id) => `unconfigured-${id}`));
  for (const part of parts) {
    expect({ part, measured: !!all[part] }).toEqual({ part, measured: true });
    expectInside(all[part], card, part);
  }
  expectInside(card, { x: 0, y: 0, w: width, h: 1e6 }, "channels card on the page");
  expect(all.metrics.y).toBeGreaterThanOrEqual(card.y + card.h);
  expect(all.channels.y + all.channels.h).toBeLessThanOrEqual(all.panel.y + all.panel.h);
}

for (const [name, width] of [
  ["a desktop", 1100],
  ["a phone", 390],
  ["a narrow phone", 320],
] as const) {
  test(`on ${name} the channels card holds its lines, closed and opened`, async () => {
    const app = await openPanel(width);
    await app.waitFor("id:runtime-unconfigured");
    await app.waitUntil(() => !!frames(app)["entry-x"] && !!frames(app).metrics);
    expectContained(app, width, false);
    await app.press("id:runtime-unconfigured");
    await app.waitFor("id:runtime-unconfigured-list");
    await app.waitUntil(() => !!frames(app)["unconfigured-bluesky"]);
    await app.wait(100);
    expectContained(app, width, true);
    if (width < 980) {
      // Stacked, each card is as tall as what it holds: the model card no taller than its two
      // rows' card on a desktop would be, the channels card not squeezed.
      const all = frames(app);
      expect(all.channels.y).toBeGreaterThanOrEqual(all.model.y + all.model.h);
      expect(all.model.h).toBeLessThan(all.channels.h);
    } else {
      // Side by side, sharing the row.
      const all = frames(app);
      expect(Math.abs(all.model.w - all.channels.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(all.model.y - all.channels.y)).toBeLessThanOrEqual(0.5);
    }
    app.dispose();
  });
}

test("the channels card holds its longer lines in Japanese on a narrow phone", async () => {
  const app = await openPanel(320, "ja");
  await app.waitFor("id:runtime-unconfigured");
  await app.press("id:runtime-unconfigured");
  await app.waitFor("id:runtime-unconfigured-list");
  await app.waitUntil(() => !!frames(app)["unconfigured-bluesky"] && !!frames(app).metrics);
  await app.wait(100);
  expect(app.shows("text:12 件のタスクを実行中")).toBe(true);
  expectContained(app, 320, true);
  app.dispose();
});
