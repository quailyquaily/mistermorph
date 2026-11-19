// The Processes and Progress trees' connectors (components/chat/TreeBranch.tsx): strokes laid out
// beside each row, never box-drawing glyphs in its text. A row that is not its parent's last
// carries its trunk down its whole height (through a wrapping command, a failed shell call's
// result, an error, its descendants and the room before the next row) into the next sibling's; the
// last one's trunk ends at its branch, while its descendants draw their own one level in. Each
// branch points at the middle of its row's header line, from the trunk to the gap before the
// header. The same on a desktop, on a narrow window and on Android, and when the last row goes
// (the one before becomes the last). Fixture: tests/fixtures/tree-connectors-app.tsx.
import { expect, open, test, type App } from "nsh/test";
import { TREE_BRANCH_END, TREE_INDENT, TREE_STROKE, TREE_TRUNK_X } from "../components/chat/TreeBranch";

type Frame = { x: number; y: number; w: number; h: number };
type Report = { version: number; parts: Record<string, Frame> };
/** A tree's rows as the fixture draws them: an id, and its children's rows. */
type Node = { id: string; children?: Node[] };

const PROCESSES: Node[] = [
  { id: "10", children: [{ id: "11", children: [{ id: "12" }] }, { id: "13" }] },
  { id: "20", children: [{ id: "21" }] },
];
const CALLS: Node[] = [{ id: "many:c1" }, { id: "many:c2" }, { id: "many:c3" }, { id: "many:c4" }];
const SINGLE: Node[] = [{ id: "single:s1" }];

const VIEWS = [
  { name: "a desktop", width: 700, platform: "linux" },
  { name: "a narrow window", width: 320, platform: "linux" },
  { name: "Android", width: 360, platform: "android" },
] as const;

function report(app: App): Report {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"version"')) ?? '{"version":0,"parts":{}}') as Report;
}

/** Measures every part again (rows move without a layout of their own) and returns the frames. */
async function measure(app: App) {
  const before = report(app).version;
  await app.press("id:measure");
  await app.waitUntil(() => report(app).version > before);
  return report(app).parts;
}

async function openTrees(view: (typeof VIEWS)[number]) {
  const app = await open("./fixtures/tree-connectors-app.tsx", { width: view.width, height: 2400, platform: view.platform, locale: "en-US" });
  await app.waitFor("id:chat-process-row");
  await app.wait(100);
  return app;
}

const bottom = (frame: Frame) => frame.y + frame.h;

function part(parts: Record<string, Frame>, name: string): Frame {
  const frame = parts[name];
  if (!frame) throw new Error(`no frame for ${name}`);
  return frame;
}

/** The deepest bottom of a row's last descendants (its own bottom when it has none). */
function lastBottom(parts: Record<string, Frame>, node: Node): number {
  const children = node.children ?? [];
  return children.length ? lastBottom(parts, children[children.length - 1]) : bottom(part(parts, `row:${node.id}`));
}

/** Every sibling list of `nodes`, checked as above; `trunkX` is where its trunks stand. */
function expectTree(parts: Record<string, Frame>, nodes: Node[], trunkX?: number) {
  nodes.forEach((node, index) => {
    const row = part(parts, `row:${node.id}`);
    const trunk = part(parts, `trunk:${node.id}`);
    const branch = part(parts, `branch:${node.id}`);
    const mark = part(parts, `mark:${node.id}`);
    const content = part(parts, `content:${node.id}`);
    const last = index === nodes.length - 1;

    // The column: a fixed indent, the trunk and its branch one stroke thick.
    expect(trunk.x).toBe(row.x + TREE_TRUNK_X);
    if (trunkX !== undefined) expect(trunk.x).toBe(trunkX);
    expect(trunk.w).toBe(TREE_STROKE);
    expect(branch.h).toBe(TREE_STROKE);
    expect(content.x).toBe(row.x + TREE_INDENT);
    // The trunk starts at the row's top (the room above the row is the row's own).
    expect(trunk.y).toBe(row.y);
    // The branch runs from the trunk to the gap before the header, through its line's middle.
    expect(branch.x).toBe(trunk.x);
    expect(branch.x + branch.w).toBe(row.x + TREE_BRANCH_END);
    expect(branch.x + branch.w).toBeLessThan(mark.x);
    expect(Math.abs(branch.y + branch.h / 2 - (mark.y + mark.h / 2))).toBeLessThanOrEqual(0.5);

    if (last) {
      // The last row's trunk ends at its branch: nothing of it hangs below.
      expect(bottom(trunk)).toBe(bottom(branch));
    } else {
      // Down the row's whole height, past its descendants, into the next row's trunk.
      const next = part(parts, `row:${nodes[index + 1].id}`);
      expect(bottom(trunk)).toBe(bottom(row));
      expect(next.y).toBe(bottom(row));
      expect(part(parts, `trunk:${nodes[index + 1].id}`).y).toBe(bottom(trunk));
      expect(bottom(trunk)).toBeGreaterThanOrEqual(lastBottom(parts, node));
    }

    const children = node.children ?? [];
    if (children.length) {
      // Children are one level in, under the header, with trunks of their own.
      const first = part(parts, `row:${children[0].id}`);
      expect(first.x).toBe(content.x);
      expect(first.y).toBeGreaterThan(bottom(branch));
      if (last) expect(bottom(trunk)).toBeLessThan(first.y);
      expectTree(parts, children, trunk.x + TREE_INDENT);
    }
  });
}

for (const view of VIEWS) {
  test(`on ${view.name} the process tree's trunks run through commands and descendants`, async () => {
    const app = await openTrees(view);
    const parts = await measure(app);
    expectTree(parts, PROCESSES, part(parts, "row:10").x + TREE_TRUNK_X);
    // The long command wraps on narrow screens; the trunk beside it is one stroke all the same.
    if (view.width < 400) {
      expect(part(parts, "command:10").h).toBeGreaterThan(part(parts, "command:20").h * 1.5);
      expect(part(parts, "command:13").h).toBeGreaterThan(part(parts, "command:21").h * 1.5);
    }
    // Every row's content stays on screen.
    for (const [name, frame] of Object.entries(parts)) {
      if (name.startsWith("row:")) expect(frame.x + frame.w).toBeLessThanOrEqual(view.width);
    }
  });

  test(`on ${view.name} the call tree's trunks run through results and errors`, async () => {
    const app = await openTrees(view);
    const parts = await measure(app);
    expectTree(parts, CALLS);
    expectTree(parts, SINGLE);
    // Calls not kept: a dashed trunk on into the first call's, with no branch.
    const omitted = part(parts, "row:many:omitted");
    const elided = part(parts, "trunk:many:omitted");
    expect(parts["branch:many:omitted"]).toBe(undefined);
    expect(elided.x).toBe(part(parts, "trunk:many:c1").x);
    expect(elided.y).toBe(omitted.y);
    expect(bottom(elided)).toBe(part(parts, "row:many:c1").y);
    expect(app.shows("id:call-tree >> id:chat-activity-calls-omitted")).toBe(true);
    expect(app.shows("id:call-tree >> text:2 earlier calls")).toBe(true);
    // A call with details: the trunk passes beside them all, unless the call is the last.
    for (const id of ["many:c2", "many:c3"]) {
      expect(bottom(part(parts, `trunk:${id}`))).toBeGreaterThanOrEqual(bottom(part(parts, `detail:${id}`)));
    }
    expect(bottom(part(parts, "trunk:many:c4"))).toBeLessThan(part(parts, "detail:many:c4").y);
    expect(bottom(part(parts, "trunk:single:s1"))).toBeLessThan(part(parts, "detail:single:s1").y);
    // The failed shell call's result and the error are all there, beside the trunk.
    expect(app.shows("id:call-tree >> id:chat-activity-shell")).toBe(true);
    expect(app.shows("id:call-tree >> text:/line two of stderr/")).toBe(true);
    expect(app.shows("id:call-tree >> text:/fetch failed/")).toBe(true);
    expect(app.shows("id:single-tree >> text:ls: no such file")).toBe(true);
    if (view.width < 400) {
      // The error wraps onto lines of its own: the trunk still reaches the next call.
      expect(part(parts, "detail:many:c3").h).toBeGreaterThan(part(parts, "detail:single:s1").h * 1.5);
    }
  });
}

test("the trees draw no box-drawing glyphs: what reads out is the rows' own text", async () => {
  const app = await openTrees(VIEWS[0]);
  for (const text of app.texts()) expect(/[├└│┆─]/.test(text)).toBe(false);
  expect(app.shows("id:process-tree >> text:10 npm")).toBe(true);
  expect(app.shows("id:process-tree >> text:12 esbuild")).toBe(true);
});

test("a row that becomes its parent's last ends its trunk at its branch, and back", async () => {
  const app = await openTrees(VIEWS[0]);
  let parts = await measure(app);
  expect(bottom(part(parts, "trunk:10"))).toBe(bottom(part(parts, "row:10")));
  expect(bottom(part(parts, "trunk:11"))).toBe(bottom(part(parts, "row:11")));

  // The first child's last child goes: the first child is now its parent's last.
  await app.press("id:drop-child");
  parts = await measure(app);
  expect(parts["row:13"]).toBe(undefined);
  expectTree(parts, [{ id: "10", children: [{ id: "11", children: [{ id: "12" }] }] }, { id: "20", children: [{ id: "21" }] }]);
  expect(bottom(part(parts, "trunk:11"))).toBe(bottom(part(parts, "branch:11")));

  // The last root goes: the first root is now the last, its descendants keep their own trunks.
  await app.press("id:drop-last");
  parts = await measure(app);
  expect(parts["row:20"]).toBe(undefined);
  expectTree(parts, [{ id: "10", children: [{ id: "11", children: [{ id: "12" }] }] }]);
  expect(bottom(part(parts, "trunk:10"))).toBe(bottom(part(parts, "branch:10")));
  expect(part(parts, "trunk:12").y).toBe(part(parts, "row:12").y);
});
