import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { computed, effectScope, nextTick, reactive, ref, watch } from "vue";

const source = (await readFile(new URL("../views/AuditView.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "")
  .replace("export default AuditView;", "globalThis.AuditView = AuditView;");
const files = ["guard_audit.jsonl", "guard_audit.deny.jsonl"];
const event = (extra = {}) => JSON.stringify({
  event_id: "evt_one", run_id: "run_one", ts: "2026-09-21T08:00:00Z", step: 1,
  action_type: "ToolCallPre", tool_name: "url_fetch", decision: "allow", risk_level: "low",
  action_summary_redacted: "GET https://example.com/report", ...extra,
});
const chunk = (items = [event()], extra = {}) => ({ exists: true, items, has_next: false, ...extra });
const flush = async () => { await new Promise(setImmediate); await nextTick(); };

function mount(t, fetch) {
  let mounted;
  let tick;
  const taskResource = { loading: ref(false), error: ref(null), data: ref(null), refresh: async () => {} };
  const context = {
    computed, reactive, ref, watch, URLSearchParams, Date,
    AppPage: {}, RawJsonDialog: {}, TASK_STATUS_META: [],
    useRouter: () => ({ push() {} }),
    onMounted: (fn) => { mounted = fn; }, onUnmounted() {},
    window: { innerWidth: 1440, addEventListener() {}, removeEventListener() {}, setInterval(fn) { tick = fn; }, clearInterval() {} },
    document: { hidden: false, querySelector: () => null },
    endpointState: reactive({ selectedRef: "ep_one" }),
    runtimeEndpointByRef: (endpoint_ref) => ({ endpoint_ref }),
    runtimeApiFetchForEndpoint: (_endpoint, path) => fetch(path),
    loadResource: (_key, loader) => loader(), resourceKey: (...args) => args.join(":"),
    useResource: () => taskResource,
    translate: (key, args = {}) => `${key}${Object.values(args).join(" ")}`,
    formatTime: (value) => value,
    formatShortTime: (value) => value,
    safeJSON: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
    toBool: (value, fallback) => typeof value === "boolean" ? value : fallback,
    toInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    endpointChannelLabel: () => "Console",
  };
  vm.runInNewContext(source, context);
  const scope = effectScope();
  const view = scope.run(() => context.AuditView.setup());
  t.after(() => scope.stop());
  mounted();
  return { view, tick: () => tick(), context, taskResource };
}

function respond(path, payload = chunk()) {
  return path === "/audit/files"
    ? { default_file: files[0], items: files.map(name => ({ name })) }
    : payload;
}

test("switching files clears old rows and pagination even when the new request fails", async (t) => {
  let reject;
  const { view } = mount(t, async path => path.includes("deny")
    ? new Promise((_resolve, fail) => { reject = fail; })
    : respond(path, chunk([event()], { has_next: true, next_cursor: "page-2" })));
  await flush();
  await view.goNext();
  assert.equal(view.pageValue.value, 2);
  const pending = view.onFileChange(view.fileItems.value[1]);
  assert.equal(view.auditGroups.value.length, 0);
  assert.equal(view.pageValue.value, 1);
  assert.equal(view.meta.has_next, false);
  reject(new Error("unavailable"));
  await pending;
  assert.equal(view.err.value, "unavailable");
  assert.equal(view.auditGroups.value.length, 0);
});

test("a late file response cannot overwrite the currently selected file", async (t) => {
  let resolveOld;
  const { view } = mount(t, async path => path.includes("deny")
    ? new Promise(resolve => { resolveOld = resolve; }) : respond(path));
  await flush();
  const old = view.onFileChange(view.fileItems.value[1]);
  await view.onFileChange(view.fileItems.value[0]);
  resolveOld(chunk([event({ decision: "deny", run_id: "old_run" })]));
  await old;
  assert.equal(view.auditGroups.value[0].runID, "run_one");
  assert.equal(view.loading.value, false);
});

test("file catalog failure remains visible and retry can recover", async (t) => {
  let fail = true;
  const { view } = mount(t, async path => {
    if (path === "/audit/files" && fail) throw new Error("catalog unavailable");
    return respond(path);
  });
  await flush();
  assert.equal(view.err.value, "catalog unavailable");
  assert.equal(view.loading.value, false);
  fail = false;
  await view.refreshAudit();
  assert.equal(view.err.value, "");
  assert.equal(view.auditGroups.value.length, 1);
});

test("archives are distinguishable and ordered newest first after current files", async (t) => {
  const names = ["guard_audit.jsonl.20260919T080000Z", "guard_audit.jsonl.20260920T080000Z", ...files];
  const { view } = mount(t, async path => path === "/audit/files"
    ? { items: names.map(name => ({ name })) } : chunk());
  await flush();
  assert.deepEqual(Array.from(view.fileItems.value, item => item.name), [
    ...files, "guard_audit.jsonl.20260920T080000Z", "guard_audit.jsonl.20260919T080000Z",
  ]);
  assert.equal(view.fileItems.value[0].archived, false);
  assert.equal(view.fileItems.value[2].archived, true);
  assert.notEqual(view.fileItems.value[2].subtitle, view.fileItems.value[3].subtitle);
});

test("events retain approval outcomes and actors without changing the original decision", async (t) => {
  const { view } = mount(t, async path => respond(path, chunk([
    event({ approval_status: "approved", actor: "reviewer", approval_request_id: "apr_one", decision: "require_approval", step: -1 }),
  ])));
  await flush();
  const item = view.auditGroups.value[0].items[0];
  assert.equal(item.approvalLabel, "audit_approval_approved");
  // Approved is a routine outcome: quiet badge. The original decision still reads as needing attention.
  assert.deepEqual({ ...item.approvalBadge }, { type: "default", variant: "outlined" });
  assert.deepEqual({ ...item.decisionBadge }, { type: "warning", variant: "filled" });
  assert.equal(item.actor, "reviewer");
  assert.equal(item.approvalRequestID, "apr_one");
  assert.equal(item.decisionLabel, "audit_decision_require_approval");
  assert.equal(item.stepText, "-");
});

test("omitted output uses a readable summary while raw data and real summaries are preserved", async (t) => {
  const placeholder = event({ action_type: "OutputPublish", action_summary_redacted: "OutputPublish content=[redacted_summary]" });
  const { view } = mount(t, async path => respond(path, chunk([
    placeholder, event({ event_id: "evt_two", action_type: "OutputPublish", body_omitted_from_audit: true, action_summary_redacted: "Published a report" }), "malformed line",
  ])));
  await flush();
  const items = view.auditGroups.value.flatMap(group => group.items);
  assert.equal(items.find(item => item.eventID === "evt_one").summary, "audit_output_publish_summary");
  assert.equal(items.find(item => item.eventID === "evt_one").raw, placeholder);
  assert.equal(items.find(item => item.eventID === "evt_two").summary, "Published a report");
  assert.ok(items.some(item => !item.parsed && item.raw === "malformed line"));
});

test("page filtering matches IDs, translated outcomes and malformed records", async (t) => {
  const { view } = mount(t, async path => respond(path, chunk([
    event(), event({ event_id: "evt_two", run_id: "run_two", approval_status: "denied" }), "broken record",
  ])));
  await flush();
  for (const [query, expected] of [["RUN_TWO", 1], ["audit_approval_denied", 1], ["broken", 1], ["no match", 0], ["", 3]]) {
    view.filterText.value = query;
    assert.equal(view.auditGroups.value.flatMap(group => group.items).length, expected);
  }
});

test("refreshing preserves event identity when the latest page shifts", async (t) => {
  let items = [event({ event_id: "evt_old" }), event()];
  const { view, tick } = mount(t, async path => respond(path, chunk(items)));
  await flush();
  const key = view.auditGroups.value[0].items[0].key;
  items = [event(), event({ event_id: "evt_two" })];
  tick(); await flush();
  assert.equal(view.auditGroups.value[0].items.find(item => item.eventID === "evt_one").key, key);
});

test("changing task pages clears previous rows and a successful retry clears the error", async (t) => {
  const { view, taskResource } = mount(t, async path => respond(path));
  await flush();
  taskResource.data.value = { endpointRef: "ep_one", items: [{ id: "task_one" }], nextCursor: "tasks-2" };
  await nextTick();
  view.nextTaskPage();
  assert.equal(view.taskItems.value.length, 0);
  taskResource.error.value = new Error("task page unavailable");
  await nextTick();
  assert.equal(view.taskErr.value, "task page unavailable");
  taskResource.error.value = null;
  taskResource.data.value = { endpointRef: "ep_one", items: [{ id: "task_two" }], nextCursor: "" };
  await nextTick();
  assert.equal(view.taskErr.value, "");
  assert.equal(view.taskItems.value[0].id, "task_two");
});

test("changing endpoints discards both previous data and pending responses", async (t) => {
  let resolveOld;
  let delayLogs = false;
  const { view, context, tick } = mount(t, async path => {
    if (delayLogs && path.startsWith("/audit/logs")) {
      delayLogs = false;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return respond(path);
  });
  await flush();
  delayLogs = true;
  tick();
  context.endpointState.selectedRef = "ep_two";
  await flush();
  resolveOld(chunk([event({ run_id: "old_endpoint" })]));
  await flush();
  assert.equal(view.auditGroups.value[0].runID, "run_one");
  assert.equal(view.loading.value, false);
});
