import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { computed, effectScope, nextTick, ref, watch } from "vue";
import { buildComposerSubmission, clipboardImageFiles, composerFileDraftKey } from "./chat-composer-files.js";
import * as suggestions from "./chat-composer-suggestions.js";
import { normalizeTopicID } from "./chat-task-history.js";

const componentSource = await readFile(new URL("../components/ChatComposer.js", import.meta.url), "utf8");
const viewSource = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
const flush = async () => { await new Promise(setImmediate); await nextTick(); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const image = () => new File(["image bytes"], "paste.png", { type: "image/png" });
const uploaded = (name = "paste.png") => ({ dir_name: "file_cache_dir", path: `console/${name}`, name });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function event(files = [], text = "") {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    clipboardData: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      files,
      getData: () => text,
    },
    dataTransfer: { types: files.length ? ["Files"] : ["text/plain"], files },
  };
}

function composer(t, props = {}) {
  const events = [];
  const context = {
    computed, nextTick, ref, watch, clipboardImageFiles, ...suggestions,
    onMounted() {}, onUnmounted() {},
  };
  vm.runInNewContext(componentSource.replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export default", "globalThis.component ="), context);
  const defaults = Object.fromEntries(Object.entries(context.component.props).map(([key, definition]) => [
    key, typeof definition.default === "function" ? definition.default() : definition.default,
  ]));
  const scope = effectScope();
  const state = scope.run(() => context.component.setup({ ...defaults, ...props }, {
    emit: (...args) => events.push(args), expose() {},
  }));
  t.after(() => scope.stop());
  return { state, events };
}

// Execute the view's real handlers with its network and unrelated UI dependencies replaced.
// Keeping the upload, draft, drop and send code together checks their shared state transitions.
function view(fetch = async () => ({ files: [uploaded()] })) {
  const drafts = new Map();
  let historyID = 0;
  const state = {
    ref, computed, nextTick, File, FormData,
    buildComposerSubmission, composerFileDraftKey, normalizeTopicID,
    composerFiles: ref([]), composerFileDrafts: new Map(),
    composerDraftScope: ref({ endpointRef: "ep_one", topicID: "" }),
    submitEndpointRef: ref("ep_one"), composerDisabled: ref(false), composerAddDisabled: ref(false),
    pendingWorkspaceDir: ref(""), workspaceDir: ref(""), workspaceTopicID: ref(""),
    workspaceSidebarOpen: ref(false), workspaceSidebarTabID: ref("workspace"), WORKSPACE_TAB_ID: "workspace",
    composerRef: ref(null), composerFilePreviewID: ref(""),
    taskInput: ref("  describe the image\n"), sending: ref(false), err: ref(""),
    consoleTopicsEnabled: ref(true), creatingTopic: ref(true), selectedTopicID: ref(""),
    composerLLMProfile: ref("quality"), suppressDraftPersistence: ref(false),
    submitBlockedMessage: ref(""), activeAgentName: ref("Agent"), historyItemsScope: ref(""),
    topics: ref([]), topicsLoading: ref(false), topicsNextCursor: ref(""), showSystemTopics: ref(false),
    topicLayoutEndpoint: "ep_one", TOPIC_PAGE_LIMIT: 100, AWARENESS_TOPIC_ID: "_awareness",
    loadTopicLayout() {}, resetTopicState() {}, syncMobileTopicView() {}, compareTopicsNewestFirst: () => 0,
    chatHistoryItems: ref([]), CONSOLE_CHAT_TRIGGER: { source: "ui", event: "chat_submit", ref: "web/console/chat" },
    t: (key) => key,
    runtimeApiFetchForEndpoint: (...args) => fetch(...args),
    loadWorkspaceTree: async () => {}, closeComposerFilePreview() {},
    rememberChatDraft: (endpointRef, topicID, text) => drafts.set(composerFileDraftKey({ endpointRef, topicID }), text),
    clearChatDraft: (endpointRef, topicID) => drafts.delete(composerFileDraftKey({ endpointRef, topicID })),
    pushHistoryItem(item) { const id = ++historyID; state.chatHistoryItems.value.push({ ...item, id }); return id; },
    patchHistoryItem(id, patch) { Object.assign(state.chatHistoryItems.value.find((item) => item.id === id), patch); },
    newHistoryID: () => ++historyID,
    buildPollingHint: () => "Waiting", historyTimeLabel: () => "Now", isContextCompactCommand: () => false,
    normalizeTaskStatus: (status) => status, normalizeHistoryFileReferences: (files) => files,
    historyPendingSeed: (_item, seed) => seed, historyScope: () => "topic",
    scrollHistoryToBottom() {}, applyComposerTopicLLMProfile() {}, startTaskStream() {},
    applyWorkspacePayload() {}, rememberWorkspaceBrowserRecentDir() {}, rememberTopicSelection() {},
    loadTopics: async () => {}, syncChatRoute: async () => {}, pollTask: async () => {},
    syncComposer() {}, focusComposerOnDesktop() {},
  };
  function section(start, end) {
    const from = viewSource.indexOf(start);
    const to = viewSource.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing view section: ${start}`);
    return viewSource.slice(from, to);
  }
  vm.runInNewContext([
    "let composerFileSequence = 0;",
    section("    const composerUploading = computed", "    const composerFilePreviewOpen"),
    section("    function setComposerFileDraft", "    function syncComposer"),
    section("    async function uploadComposerFiles", "    function releaseComposerFilePreviewURL"),
    section("    function removeComposerFile", "    function resetWorkspaceTreeState"),
    section("    async function submitTask", "    useTopicMetadata"),
    `globalThis.refreshTopics = ${section("    async function loadTopics", "    async function loadOlderTopics").trim()};`,
    "globalThis.dropActive = composerDropActive; globalThis.uploading = composerUploading;",
  ].join("\n"), state);
  state.switchTo = (endpointRef, topicID, text = "other draft") => {
    state.submitEndpointRef.value = endpointRef;
    state.selectedTopicID.value = topicID;
    state.composerDraftScope.value = { endpointRef, topicID };
    state.restoreComposerFileDraft();
    state.taskInput.value = text;
  };
  return { state, drafts };
}

test("image paste emits the actual file once; ordinary and mixed text paste retain browser insertion", (t) => {
  const { state, events } = composer(t);
  const file = image();
  const paste = event([file]);
  state.handlePaste(paste);
  assert.equal(paste.defaultPrevented, true);
  assert.equal(events[0][0], "attachFiles");
  assert.deepEqual(events[0][1], [file]);
  const text = event([], "ordinary text");
  state.handlePaste(text);
  assert.equal(text.defaultPrevented, false);
  assert.equal(events.length, 1);
  const mixed = event([file], "image caption");
  state.handlePaste(mixed);
  assert.equal(mixed.defaultPrevented, false);
  assert.equal(events.length, 2);
});

test("clipboard extraction handles files-only browsers, unnamed images and null items", () => {
  const file = image();
  assert.deepEqual(clipboardImageFiles({ files: [file, new File(["text"], "note.txt")] }), [file]);
  const [named] = clipboardImageFiles({ files: [new File(["bytes"], "", { type: "image/jpeg" })] });
  assert.equal(named.name, "clipboard-image-1.jpg");
  assert.equal(named.type, "image/jpeg");
  assert.deepEqual(clipboardImageFiles({ items: [{ kind: "file", type: "image/png", getAsFile: () => null }] }), []);
});

test("disabled composers do not attach pasted files", (t) => {
  for (const props of [{ disabled: true }, { attachDisabled: true }]) {
    const { state, events } = composer(t, props);
    state.handlePaste(event([image()]));
    assert.equal(events.length, 0);
  }
});

test("both composers wire paste, retry and removal to the existing attachment UI", () => {
  assert.match(componentSource, /@paste="handlePaste"/);
  assert.match(componentSource, /v-for="item in fileItems"/);
  assert.match(componentSource, /@click="\$emit\('removeFile', item\)"/);
  assert.match(componentSource, /@click="\$emit\('retryFile', item\)"/);
  assert.equal((viewSource.match(/@attach-files="uploadComposerFileList"/g) || []).length, 2);
  assert.equal((viewSource.match(/@retry-file="uploadComposerFileList\(\[\$event.sourceFile\], \$event.id\)"/g) || []).length, 2);
  assert.equal((viewSource.match(/@remove-file="removeComposerFile"/g) || []).length, 2);
  assert.match(viewSource, /window.addEventListener\("drop", preventWindowFileDrop\)/);
  assert.match(viewSource, /window.removeEventListener\("drop", preventWindowFileDrop\)/);
});

test("multiple dropped files upload bytes before the first conversation exists", async () => {
  const pending = deferred();
  let request;
  const { state } = view((endpoint, path, options) => { request = { endpoint, path, ...options }; return pending.promise; });
  const files = [image(), new File(["document contents"], "notes.txt")];
  const drop = event(files);
  state.onChatPaneDragEnter(drop);
  state.onChatPaneDragEnter(drop);
  state.onChatPaneDragLeave(drop);
  assert.equal(state.dropActive.value, true);
  state.onChatPaneDragOver(drop);
  assert.equal(drop.dataTransfer.dropEffect, "copy");
  state.onChatPaneDrop(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(state.dropActive.value, false);
  assert.deepEqual(plain(state.composerFiles.value.map((item) => item.status)), ["uploading", "uploading"]);
  assert.equal(request.endpoint, "ep_one");
  assert.equal(request.path, "/files/upload");
  const payload = request.body.getAll("files");
  assert.equal(await payload[0].text(), "image bytes");
  assert.equal(await payload[1].text(), "document contents");
  assert.equal(request.body.has("topic_id"), false);
  pending.resolve({ files: [uploaded(), uploaded("notes.txt")] });
  await flush();
  assert.deepEqual(plain(state.composerFiles.value.map((item) => item.status)), ["ready", "ready"]);
});

test("window drops cannot navigate away, and non-file drags remain untouched", () => {
  const { state } = view();
  const outside = event([image()]);
  state.preventWindowFileDrop(outside);
  assert.equal(outside.defaultPrevented, true);
  const text = event([], "topic");
  state.onChatPaneDragEnter(text);
  state.onChatPaneDrop(text);
  state.preventWindowFileDrop(text);
  assert.equal(text.defaultPrevented, false);
  state.composerAddDisabled.value = true;
  const blocked = event([image()]);
  state.onChatPaneDragOver(blocked);
  state.onChatPaneDrop(blocked);
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(blocked.dataTransfer.dropEffect, "none");
  assert.equal(state.composerFiles.value.length, 0);
});

test("removal during upload stays removed when a late response arrives", async () => {
  const pending = deferred();
  const { state } = view(() => pending.promise);
  const uploading = state.uploadComposerFileList([image()]);
  state.removeComposerFile(state.composerFiles.value[0]);
  assert.equal(state.composerFiles.value.length, 0);
  pending.resolve({ files: [uploaded()] });
  await uploading;
  assert.equal(state.composerFiles.value.length, 0);
});

test("failed and unsupported uploads keep the draft and file, block send, and retry in place", async () => {
  for (const message of ["Network unavailable", "Unsupported file", "upload exceeds 64 MiB"]) {
    let attempts = 0;
    const file = image();
    const { state } = view(async (_endpoint, path, options) => {
      assert.equal(path, "/files/upload", "failed files must not be silently omitted from a task");
      assert.equal(await options.body.get("files").text(), "image bytes");
      if (++attempts === 1) throw new Error(message);
      return { files: [uploaded()] };
    });
    await state.uploadComposerFileList([file]);
    const failed = state.composerFiles.value[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.sourceFile, file);
    assert.ok(failed.error.includes(message));
    assert.ok(failed.error.includes("chat_composer_file_retry_hint"));
    await state.submitTask();
    assert.equal(attempts, 1);
    assert.equal(state.taskInput.value, "  describe the image\n");
    await state.uploadComposerFileList([failed.sourceFile], failed.id);
    assert.equal(state.composerFiles.value.length, 1);
    assert.equal(state.composerFiles.value[0].id, failed.id);
    assert.equal(state.composerFiles.value[0].status, "ready");
  }
});

test("invalid upload responses remain retryable and removal permits sending the text alone", async () => {
  for (const files of [[], [{ dir_name: "browser", path: "blob:local" }]]) {
    const { state } = view(async () => ({ files }));
    await state.uploadComposerFileList([image()]);
    assert.equal(state.composerFiles.value[0].status, "failed");
    state.removeComposerFile(state.composerFiles.value[0]);
    let request;
    state.runtimeApiFetchForEndpoint = async (_endpoint, _path, options) => {
      request = options.body;
      return { id: "task", topic_id: "topic", status: "queued" };
    };
    await state.submitTask();
    assert.equal(request.task, "describe the image");
    assert.equal(request.file_references, undefined);
  }
});

test("concurrent uploads and navigation retain the captured endpoint and topic scope", async () => {
  const first = deferred();
  const second = deferred();
  const requests = [];
  const { state } = view((endpoint, _path, options) => {
    requests.push({ endpoint, body: options.body });
    return requests.length === 1 ? first.promise : second.promise;
  });
  state.switchTo("ep_one", "topic-one");
  state.workspaceTopicID.value = "topic-one";
  const one = state.uploadComposerFileList([image()]);
  const two = state.uploadComposerFileList([new File(["notes"], "notes.txt")]);
  assert.equal(state.composerFiles.value.length, 2);
  state.switchTo("ep_two", "topic-two");
  assert.equal(state.uploading.value, false);
  first.resolve({ files: [uploaded()] });
  second.reject(new Error("offline"));
  await Promise.all([one, two]);
  assert.equal(state.composerFiles.value.length, 0);
  assert.equal(state.taskInput.value, "other draft");
  state.switchTo("ep_one", "topic-one");
  assert.deepEqual(plain(state.composerFiles.value.map((item) => item.status)), ["ready", "failed"]);
  assert.deepEqual(requests.map((item) => [item.endpoint, item.body.get("topic_id")]), [["ep_one", "topic-one"], ["ep_one", "topic-one"]]);
});

test("sending submits uploaded references; failed sends preserve exact text and files for retry", async () => {
  const requests = [];
  const { state, drafts } = view(async (_endpoint, path, options) => {
    if (path === "/files/upload") return { files: [uploaded()] };
    requests.push(options.body);
    if (requests.length === 1) throw new Error("Send failed");
    return { id: "task", topic_id: "new-topic", status: "queued" };
  });
  await state.uploadComposerFileList([image()]);
  await state.submitTask();
  assert.equal(state.taskInput.value, "  describe the image\n");
  assert.equal(drafts.get("ep_one\n"), "  describe the image\n");
  assert.equal(state.composerFiles.value[0].status, "ready");
  assert.equal(state.err.value, "Send failed");
  await state.submitTask();
  assert.deepEqual(plain(requests[0]), plain(requests[1]));
  assert.deepEqual(plain(requests[1].file_references), [{ dir_name: "file_cache_dir", path: "console/paste.png" }]);
  assert.equal(requests[1].llm_profile, "quality");
  assert.equal(state.composerFiles.value.length, 0);
  assert.equal(state.taskInput.value, "");
  assert.equal(drafts.size, 0);
});

test("empty input and uploads in progress never submit", async () => {
  let requests = 0;
  const { state } = view(async () => { requests++; });
  state.taskInput.value = " \n";
  await state.submitTask();
  state.taskInput.value = "describe";
  state.setComposerFileDraft(state.composerDraftScope.value, [{ status: "uploading" }]);
  await state.submitTask();
  assert.equal(requests, 0);
});

test("send completion after navigation never replaces the other draft or topic", async () => {
  for (const success of [true, false]) {
    const pending = deferred();
    const { state, drafts } = view(() => pending.promise);
    state.setComposerFileDraft(state.composerDraftScope.value, [{ id: "file", status: "ready", dirName: "file_cache_dir", path: "console/paste.png" }]);
    const sending = state.submitTask();
    state.switchTo("ep_two", "other-topic");
    state.setComposerFileDraft(state.composerDraftScope.value, [{ id: "other", status: "failed" }]);
    if (success) pending.resolve({ id: "task", topic_id: "new-topic", status: "queued" });
    else pending.reject(new Error("Send failed"));
    await sending;
    assert.equal(state.taskInput.value, "other draft");
    assert.equal(state.selectedTopicID.value, "other-topic");
    assert.equal(state.composerFiles.value[0].id, "other");
    assert.equal(state.err.value, "");
    assert.equal(drafts.has("ep_one\n"), !success);
    assert.equal(state.composerFileDrafts.has("ep_one\n"), !success);
  }
});

test("tracking failures after acceptance do not restore an already sent draft", async () => {
  const { state, drafts } = view(async (_endpoint, path) => path === "/files/upload"
    ? { files: [uploaded()] }
    : { id: "task", topic_id: "topic", status: "queued" });
  state.pollTask = async () => { throw new Error("Tracking failed"); };
  await state.uploadComposerFileList([image()]);
  await state.submitTask();
  assert.equal(state.taskInput.value, "");
  assert.equal(state.composerFiles.value.length, 0);
  assert.equal(drafts.size, 0);
  assert.equal(state.err.value, "Tracking failed");
});


test("late topic refreshes after sending cannot select a different conversation", async () => {
  for (const success of [true, false]) {
    const pending = deferred();
    const requests = [];
    const { state } = view((endpoint, path) => {
      requests.push([endpoint, path]);
      return pending.promise;
    });
    state.switchTo("ep_one", "topic-one");
    const refreshing = state.refreshTopics({ preferredTopicID: "topic-one", preserveSelection: true });
    state.switchTo("ep_two", "topic-two");
    if (success) pending.resolve({ items: [] });
    else pending.reject(new Error("Refresh failed"));
    assert.equal(await refreshing, false);
    assert.equal(requests.length, 1, "no topic lookup should run against the newly selected endpoint");
    assert.equal(requests[0][0], "ep_one");
    assert.equal(state.selectedTopicID.value, "topic-two");
    assert.equal(state.taskInput.value, "other draft");
    assert.equal(state.err.value, "");
  }
});

test("navigation while refreshing a submitted topic does not redirect back to it", async () => {
  const pending = deferred();
  const { state } = view(async () => ({ id: "task", topic_id: "topic-one", status: "queued" }));
  state.loadTopics = () => pending.promise;
  let redirected = false;
  state.syncChatRoute = async () => { redirected = true; };
  const sending = state.submitTask();
  await flush();
  state.switchTo("ep_one", "topic-two");
  pending.resolve();
  await sending;
  assert.equal(redirected, false);
  assert.equal(state.taskInput.value, "other draft");
});
