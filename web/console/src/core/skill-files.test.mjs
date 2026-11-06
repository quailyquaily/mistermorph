import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as Vue from "vue";

import * as skillFiles from "./skill-files.js";

const {
  isSelectableSkillEntry,
  normalizeSkillDirListing,
  normalizeSkillFilePreview,
  skillDirURL,
  skillFileURL,
  skillPathErrorKind,
  skillTreeRows,
  useSkillFilePreview,
} = skillFiles;

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function httpError(status, code, message = "failed") {
  const err = new Error(message);
  err.status = status;
  if (code) {
    err.code = code;
  }
  return err;
}

test("folder and file URLs carry the skill id and the relative path, encoded", () => {
  assert.equal(skillDirURL("kit"), "/settings/agent/skills/dir?id=kit");
  assert.equal(skillDirURL("kit", "references/deep dir"), "/settings/agent/skills/dir?id=kit&path=references%2Fdeep+dir");
  assert.equal(skillFileURL("my kit", "a&b/c?.md"), "/settings/agent/skills/file?id=my+kit&path=a%26b%2Fc%3F.md");
});

test("listings keep names, paths and kinds; unknown kinds cannot be opened", () => {
  const listing = normalizeSkillDirListing(
    {
      path: "scripts",
      entries: [
        { name: "run.sh", path: "scripts/run.sh", kind: "file", size: 12 },
        { name: "lib", kind: "dir" },
        { name: "odd", kind: "device" },
        { name: "" },
      ],
      capped: true,
    },
    "scripts",
  );
  assert.deepEqual(listing, {
    path: "scripts",
    entries: [
      { name: "run.sh", path: "scripts/run.sh", kind: "file", size: 12 },
      { name: "lib", path: "scripts/lib", kind: "dir", size: 0 },
      { name: "odd", path: "scripts/odd", kind: "other", size: 0 },
    ],
    capped: true,
  });
  assert.deepEqual(normalizeSkillDirListing(null, ""), { path: "", entries: [], capped: false });
  assert.equal(isSelectableSkillEntry(listing.entries[0]), true);
  for (const entry of [listing.entries[1], listing.entries[2], { kind: "symlink" }, null]) {
    assert.equal(isSelectableSkillEntry(entry), false);
  }
});

test("previews keep text exactly and never carry content for other kinds", () => {
  const text = "<script>alert(1)</script>\n  indented\n\ttabbed\n";
  assert.deepEqual(normalizeSkillFilePreview({ path: "a/x.md", name: "x.md", size: 40, kind: "text", content: text, limit: 262144 }), {
    path: "a/x.md",
    name: "x.md",
    size: 40,
    kind: "text",
    content: text,
    limit: 262144,
  });
  assert.equal(normalizeSkillFilePreview({ kind: "binary", content: "\u0000junk" }, "a/b.bin").content, "");
  assert.equal(normalizeSkillFilePreview({ kind: "too_large", content: "x" }, "big.txt").content, "");
  assert.equal(normalizeSkillFilePreview({ kind: "weird", content: "x" }, "a/b").kind, "unsupported");
  assert.equal(normalizeSkillFilePreview({}, "a/b.txt").name, "b.txt");
  assert.equal(normalizeSkillFilePreview({ kind: "text" }, "empty.txt").content, "");
});

test("errors name what went wrong; a 404 without a code means an older agent", () => {
  assert.equal(skillPathErrorKind(httpError(404, "path_not_found")), "missing");
  assert.equal(skillPathErrorKind(httpError(404, "skill_not_found")), "missing");
  assert.equal(skillPathErrorKind(httpError(403, "access_denied")), "denied");
  assert.equal(skillPathErrorKind(httpError(403, "symlink")), "symlink");
  assert.equal(skillPathErrorKind(httpError(400, "invalid_path")), "invalid");
  assert.equal(skillPathErrorKind(httpError(400, "not_directory")), "invalid");
  assert.equal(skillPathErrorKind(httpError(404)), "unsupported");
  assert.equal(skillPathErrorKind(httpError(500)), "failed");
  assert.equal(skillPathErrorKind(new Error("network")), "failed");
});

test("tree rows nest open folders and show loading, empty, error and capped lines", () => {
  const nodes = {
    "": {
      status: "ready",
      entries: [
        { name: "SKILL.md", path: "SKILL.md", kind: "file" },
        { name: "empty", path: "empty", kind: "dir" },
        { name: "refs", path: "refs", kind: "dir" },
        { name: "slow", path: "slow", kind: "dir" },
        { name: "locked", path: "locked", kind: "dir" },
        { name: "closed", path: "closed", kind: "dir" },
      ],
      capped: true,
    },
    empty: { status: "ready", entries: [] },
    refs: { status: "ready", entries: [{ name: "deep", path: "refs/deep", kind: "dir" }] },
    "refs/deep": { status: "ready", entries: [{ name: "a.md", path: "refs/deep/a.md", kind: "file" }] },
    slow: { status: "loading" },
    locked: { status: "error", error: "denied" },
    closed: { status: "ready", entries: [{ name: "hidden.txt", path: "closed/hidden.txt", kind: "file" }] },
  };
  const expanded = new Set(["empty", "refs", "refs/deep", "slow", "locked"]);
  const rows = skillTreeRows(nodes, expanded).map((row) => `${row.depth}:${row.type}:${row.path}${row.open ? ":open" : ""}`);
  assert.deepEqual(rows, [
    "0:entry:SKILL.md",
    "0:entry:empty:open",
    "1:empty:empty",
    "0:entry:refs:open",
    "1:entry:refs/deep:open",
    "2:entry:refs/deep/a.md",
    "0:entry:slow:open",
    "1:loading:slow",
    "0:entry:locked:open",
    "1:error:locked",
    "0:entry:closed",
    "0:capped:",
  ]);
  assert.deepEqual(skillTreeRows({}, new Set()).map((row) => row.type), ["loading"]);
  assert.equal(new Set(skillTreeRows(nodes, expanded).map((row) => row.key)).size, rows.length);
});

test("the preview drops answers for a file that is no longer shown", async () => {
  const pending = {};
  const calls = [];
  const preview = useSkillFilePreview((id, path) => {
    calls.push(`${id}:${path}`);
    pending[path] = deferred();
    return pending[path].promise;
  });

  const first = preview.open("kit", "a.txt");
  assert.equal(preview.path.value, "a.txt");
  assert.equal(preview.state.value.status, "loading");
  const second = preview.open("kit", "b.txt");
  pending["b.txt"].resolve({ path: "b.txt", kind: "text", content: "B" });
  await second;
  pending["a.txt"].resolve({ path: "a.txt", kind: "text", content: "A" });
  await first;
  assert.equal(preview.path.value, "b.txt");
  assert.equal(preview.state.value.data.content, "B");

  // Another skill clears the preview; a late answer for the old one does not bring it back.
  const third = preview.open("kit", "c.txt");
  preview.clear();
  pending["c.txt"].resolve({ path: "c.txt", kind: "text", content: "C" });
  await third;
  assert.equal(preview.path.value, "");
  assert.equal(preview.state.value, null);

  // SKILL.md is the document view, not a preview.
  await preview.open("kit", "SKILL.md");
  assert.equal(preview.path.value, "");
  assert.deepEqual(calls, ["kit:a.txt", "kit:b.txt", "kit:c.txt"]);
});

test("preview errors and states come from the agent's answer", async () => {
  const answers = {
    "gone.txt": Promise.reject(httpError(404, "path_not_found")),
    "link.txt": Promise.reject(httpError(403, "symlink")),
    "old.txt": Promise.reject(httpError(404)),
    "big.bin": Promise.resolve({ path: "big.bin", kind: "too_large", size: 300000, limit: 262144 }),
  };
  for (const answer of Object.values(answers)) {
    answer.catch(() => {});
  }
  const preview = useSkillFilePreview((_, path) => answers[path]);
  await preview.open("kit", "gone.txt");
  assert.equal(preview.state.value.error, "missing");
  await preview.open("kit", "link.txt");
  assert.equal(preview.state.value.error, "symlink");
  await preview.open("kit", "old.txt");
  assert.equal(preview.state.value.error, "unsupported");
  await preview.open("kit", "big.bin");
  assert.equal(preview.state.value.data.kind, "too_large");
  assert.equal(preview.state.value.data.content, "");
});

// The real tree component, with the agent replaced by a stub and translations by their keys.
const treeSource = await read("../components/SkillFileTree.js");
function loadTree(fetch) {
  const context = {
    ...Vue,
    ...skillFiles,
    endpointApiFetch: fetch,
    formatBytes: (value) => `${value} B`,
    translate: (key) => key,
  };
  vm.runInNewContext(treeSource.replace(/^import[^;]*;\n/gms, "").replace("export default", "globalThis.component ="), context);
  return context.component;
}

test("the tree reads folders when opened and starts over for another skill or agent", async () => {
  const pending = [];
  const component = loadTree((endpointRef, url) => {
    const call = { endpointRef, url, ...deferred() };
    pending.push(call);
    return call.promise;
  });
  const props = Vue.reactive({ endpointRef: "local", skillId: "kit", selectedPath: "SKILL.md", disabled: false, fallbackFiles: [] });
  const emitted = [];
  const scope = Vue.effectScope();
  const tree = scope.run(() => component.setup(props, { emit: (...args) => emitted.push(args) }));

  assert.equal(pending[0].url, "/settings/agent/skills/dir?id=kit");
  assert.deepEqual(tree.rows.value.map((row) => row.type), ["loading"]);
  pending[0].resolve({
    path: "",
    entries: [
      { name: "SKILL.md", path: "SKILL.md", kind: "file", size: 10 },
      { name: "scripts", path: "scripts", kind: "dir" },
      { name: "leak", path: "leak", kind: "symlink" },
    ],
  });
  await flush();
  assert.deepEqual(tree.rows.value.map((row) => row.path), ["SKILL.md", "scripts", "leak"]);

  // Links and folders are not files to open; files are.
  tree.choose({ path: "leak", kind: "symlink" });
  tree.choose({ path: "scripts", kind: "dir" });
  tree.choose({ path: "SKILL.md", kind: "file" });
  assert.deepEqual(emitted, [["select", "SKILL.md"]]);

  tree.toggle({ path: "scripts", kind: "dir" });
  assert.equal(pending[1].url, "/settings/agent/skills/dir?id=kit&path=scripts");
  assert.deepEqual(tree.rows.value.map((row) => `${row.type}:${row.path}`), ["entry:SKILL.md", "entry:scripts", "loading:scripts", "entry:leak"]);

  // Another skill opens while scripts/ is still loading: its late answer is dropped.
  props.skillId = "other";
  await flush();
  assert.equal(pending[2].url, "/settings/agent/skills/dir?id=other");
  pending[1].resolve({ path: "scripts", entries: [{ name: "run.sh", path: "scripts/run.sh", kind: "file" }] });
  pending[2].resolve({ path: "", entries: [{ name: "SKILL.md", path: "SKILL.md", kind: "file" }] });
  await flush();
  assert.deepEqual(tree.rows.value.map((row) => row.path), ["SKILL.md"]);

  // Another agent starts over too, and reads from that agent.
  props.endpointRef = "remote";
  await flush();
  assert.equal(pending[3].endpointRef, "remote");
  pending[3].reject(httpError(404));
  await flush();
  assert.equal(tree.unsupported.value, true, "an agent without the route falls back to the flat list");

  // A folder that cannot be read says why and can be retried.
  props.endpointRef = "local";
  await flush();
  pending[4].resolve({ path: "", entries: [{ name: "locked", path: "locked", kind: "dir" }] });
  await flush();
  assert.equal(tree.unsupported.value, false);
  tree.toggle({ path: "locked", kind: "dir" });
  pending[5].reject(httpError(403, "access_denied"));
  await flush();
  const errorRow = tree.rows.value.find((row) => row.type === "error");
  assert.equal(errorRow.error, "denied");
  assert.equal(tree.dirErrorText(errorRow), "skills_files_dir_denied");
  scope.stop();
});

test("while SKILL.md is being edited no other file can be opened", async () => {
  const component = loadTree(() => new Promise(() => {}));
  const emitted = [];
  const props = Vue.reactive({ endpointRef: "local", skillId: "kit", selectedPath: "SKILL.md", disabled: true, fallbackFiles: [] });
  const scope = Vue.effectScope();
  const tree = scope.run(() => component.setup(props, { emit: (...args) => emitted.push(args) }));
  tree.choose({ path: "notes.txt", kind: "file" });
  assert.deepEqual(emitted, []);
  scope.stop();
});

test("file text is shown escaped and preformatted, never as HTML or rendered markdown", async () => {
  const view = await read("../views/SkillsView.js");
  const tree = treeSource;
  assert.doesNotMatch(view, /v-html/);
  assert.doesNotMatch(tree, /v-html|innerHTML/);
  assert.match(view, /<pre v-else-if="filePreview && filePreview\.status === 'ready'" class="skills-file-preview"[^>]*><code>\{\{ filePreview\.data\.content \}\}<\/code><\/pre>/);
  // Only SKILL.md goes through the markdown renderer.
  assert.equal((view.match(/<MarkdownContent\b/g) || []).length, 1);
  assert.match(view, /<MarkdownContent v-else-if="documentSource"/);
});

test("the Skills page keeps SKILL.md first and resets the browser for another skill or agent", async () => {
  const view = await read("../views/SkillsView.js");
  assert.match(view, /<SkillFileTree\s+v-if="filesExpanded"[\s\S]*?:skillId="selected\.id"[\s\S]*?:disabled="editing"[\s\S]*?@select="openFile"/);
  assert.match(view, /<section v-if="viewPath"[\s\S]*?@click="showDocument"[\s\S]*?<section v-else ref="docSection" class="skills-doc" :aria-label="'SKILL\.md'">/);
  // Both the skill and the agent watchers drop a shown or loading preview.
  assert.equal((view.match(/^\s+showDocument\(\);$/gm) || []).length, 2);
  assert.match(view, /useSkillFilePreview\(\(id, path\) => endpointApiFetch\(endpointState\.selectedRef, skillFileURL\(id, path\)\)\)/);
  // Browsing only reads: no new write routes.
  for (const source of [view, treeSource, await read("./skill-files.js")]) {
    assert.doesNotMatch(source, /skills\/(dir|file)[^"`]*["`][^)]*method:/);
  }
});
