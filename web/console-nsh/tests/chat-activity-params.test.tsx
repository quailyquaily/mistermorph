// Progress and coder parameters and nested calls in the detail panel (ChatStatusCard's ParamRow and
// ActivityCallTree): a value wraps in the room left beside its key, a long word with no space in it
// too, so nothing reaches past the panel at any width; a command's `$` stays beside the command's
// first line (never on a line of its own); a multiline value keeps its lines; the values are whole
// and a press copies a term without the `$`; an empty command shows no row. The same in the
// workbench (one scroll area) and for a coder's settings and own calls.
import { expect, open, test, type App } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };
type Report = { panel: number; parts: Record<string, Frame> };

const PATH = "/home/user/projects/very/long/path/to/some/deeply/nested/module/that/never/ends/file_name.go:1234:56";
const TOKEN = `printf%s${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(3)}`;

/** The values on show, by the key they are probed under (fixtures/output-overflow-app.tsx). */
const SHORT = "cmd=go build";
const SPACED = `cmd=ls -la ${PATH}`;
const UNBROKEN = `cmd=${TOKEN}`;
const MULTILINE = `script=line one\nline two ${PATH}`;
const COMMANDS = [SHORT, SPACED, UNBROKEN, MULTILINE];
const CALLS = [`bash=rg -n "OverflowLine" ${PATH}`, `bash=${TOKEN}`, "bash=go vet\ngo test", `read_file=${PATH}`, "bash=ls"];

function report(app: App): Report {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"panel"')) ?? '{"panel":0,"parts":{}}') as Report;
}

function part(app: App, name: string): Frame {
  const frame = report(app).parts[name];
  if (!frame) throw new Error(`no frame for ${name}`);
  return frame;
}

async function openPanel(width: number, options: { worker?: boolean; dark?: boolean } = {}) {
  const app = await open("./fixtures/output-overflow-app.tsx", { width, height: 800, platform: "linux", locale: "en-US" });
  if (options.dark) await app.press("id:show-dark");
  if (options.worker) await app.press("id:show-worker");
  const names = options.worker ? ["value:cwd=" + PATH, ...CALLS.slice(0, 3).map((call) => `call:${call}`)] : [
    ...COMMANDS.flatMap((value) => [`value:${value}`, `prompt:${value}`]),
    ...CALLS.map((call) => `call:${call}`),
  ];
  await app.waitUntil(() => {
    const all = report(app);
    return all.panel > 0 && names.every((name) => (all.parts[name]?.w ?? 0) > 0);
  });
  await app.wait(50);
  return app;
}

/** Every part lies inside the panel. */
function expectInside(app: App) {
  const all = report(app);
  const frames = Object.entries(all.parts);
  expect(frames.length).toBeGreaterThan(0);
  for (const [, frame] of frames) {
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.w).toBeLessThanOrEqual(all.panel + 0.5);
  }
}

/** One line of a value: the short command's height. */
const lineHeight = (app: App) => part(app, `value:${SHORT}`).h;

for (const dark of [false, true]) {
  const look = dark ? "the workbench" : "the panel";
  for (const width of [360, 760, 1400]) {
    test(`in ${look} at ${width}pt the parameters and nested calls wrap inside it, the $ beside each command's first line`, async () => {
      const app = await openPanel(width, { dark });
      expectInside(app);
      const line = lineHeight(app);
      expect(line).toBeGreaterThan(0);
      for (const value of COMMANDS) {
        const prompt = part(app, `prompt:${value}`);
        const text = part(app, `value:${value}`);
        // Beside the value's first line: level with its top, one line tall, just before it.
        expect(Math.abs(prompt.y - text.y)).toBeLessThanOrEqual(0.5);
        expect(prompt.h).toBeLessThanOrEqual(line + 0.5);
        expect(prompt.x + prompt.w).toBeLessThanOrEqual(text.x);
        expect(text.x - (prompt.x + prompt.w)).toBeLessThan(8);
      }
      // A multiline value keeps its lines at every width.
      expect(part(app, `value:${MULTILINE}`).h).toBeGreaterThan(line * 1.8);
      expect(part(app, "call:bash=go vet\ngo test").h).toBeGreaterThan(line * 1.8);
      const wrapped = [`value:${SPACED}`, `value:${UNBROKEN}`, `value:cwd=${PATH}`, ...CALLS.slice(0, 2).map((call) => `call:${call}`)];
      if (width === 360) {
        // On a phone the long ones wrap, the one with no space too (inside the word).
        for (const name of wrapped) expect(part(app, name).h).toBeGreaterThan(line * 1.5);
      }
      if (width === 1400) {
        // Wide, they fit on one line: they wrap for the room, not always.
        for (const name of wrapped) expect(part(app, name).h).toBeLessThanOrEqual(line + 0.5);
      }
      // The short command and call never wrap.
      expect(part(app, "call:bash=ls").h).toBeLessThanOrEqual(line + 0.5);
    });
  }
}

test("the values are whole, the $ is a text of its own, and an empty command shows no row", async () => {
  const app = await openPanel(360);
  const texts = app.texts();
  for (const value of [`ls -la ${PATH}`, TOKEN, `line one\nline two ${PATH}`, "go build"]) expect(texts).toContain(value);
  expect(texts.some((text) => text.startsWith("$") && text.length > 1)).toBe(false);
  // Four commands with a value; the queued one's empty command has no row, no prompt.
  expect(app.count("id:chat-activity-prompt")).toBe(COMMANDS.length);
  expect(Object.keys(report(app).parts).some((name) => name === "param:cmd=" || name === "prompt:cmd=")).toBe(false);
});

test("a wrapped command keeps its terms' colours, the $ its own", async () => {
  const app = await openPanel(360);
  const color = (selector: string) => app.spanStyle(selector).color.toLowerCase().slice(0, 7);
  // The path in `ls -la …` is still a path (pressed, it copies itself alone: checked in Chrome,
  // headless runs cannot press a span), the command's plain text the terminal's ink, `$` green.
  expect(color("id:chat-activity-param-value >> text:/^\\/home.*56$/ >> nth=0")).toBe("#f5c56b");
  expect(color("id:chat-activity-param-value >> text:go build")).toBe("#e8eef5");
  expect(color("id:chat-activity-prompt >> text:$ >> nth=0")).toBe("#3ddc97");
});

for (const dark of [false, true]) {
  test(`a coder's settings and own calls wrap inside ${dark ? "the workbench" : "the panel"} on a phone`, async () => {
    const app = await openPanel(360, { worker: true, dark });
    expectInside(app);
    // No prompt among a coder's settings (backend, cwd); its long directory wraps beside its key.
    expect(app.count("id:chat-worker-setting")).toBe(2);
    const cwd = part(app, `value:cwd=${PATH}`);
    const row = part(app, `param:cwd=${PATH}`);
    expect(cwd.h).toBeGreaterThan(row.h - 0.5);
    for (const call of CALLS.slice(0, 2)) expect(part(app, `call:${call}`).h).toBeGreaterThan(part(app, "call:bash=go vet\ngo test").h * 0.75);
  });
}

test("a command wraps as the window narrows and unwraps as it widens, staying inside", async () => {
  const app = await openPanel(1400);
  const line = lineHeight(app);
  const token = () => part(app, `value:${UNBROKEN}`);
  expect(token().h).toBeLessThanOrEqual(line + 0.5);
  await app.setViewport(360, 800);
  await app.waitUntil(() => report(app).panel === 360 && token().h > line * 1.5);
  // (Only what changed size is measured again: the `$` keeps the place it was measured at.)
  expectInside(app);
  await app.setViewport(1400, 800);
  await app.waitUntil(() => report(app).panel === 1400 && token().h <= line + 0.5);
  expectInside(app);
});
