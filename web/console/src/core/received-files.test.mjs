import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, h, nextTick } from "vue";
import ReceivedFile from "../components/ReceivedFile.js";
import { canPreviewReceivedFile, receivedFileURL } from "./received-files.js";
import { taskListHistoryItems } from "./chat-task-history.js";

function mountFile(file, fetchBlob) {
  const node = (tag, text = "") => ({ tag, text, props: {}, children: [], parent: null });
  const renderer = createRenderer({
    createElement: node,
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    setText: (target, text) => { target.text = text; },
    setElementText: (target, text) => { target.text = text; target.children = []; },
    patchProp: (target, key, _, value) => { target.props[key] = value; },
    insert: (target, parent, anchor) => {
      target.parent = parent;
      const index = parent.children.indexOf(anchor);
      if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target);
    },
    remove: (target) => { target.parent.children = target.parent.children.filter((item) => item !== target); },
    parentNode: (target) => target.parent,
    nextSibling: () => null,
  });
  const root = node("root");
  const app = renderer.createApp({ render: () => h(ReceivedFile, { file, taskId: "task", topicId: "topic", fetchBlob }) });
  app.mount(root);
  return { root, app };
}
function textContent(node) {
  return node && node.tag !== "comment" ? node.text + node.children.map(textContent).join("") : "";
}
function find(node, tag) {
  if (node.tag === tag) return node;
  for (const child of node.children) { const found = find(child, tag); if (found) return found; }
  return null;
}

for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
  test(`received ${type} renders an image and download action`, async () => {
    const requests = [];
    const { root, app } = mountFile({ id: "id", name: "photo", content_type: type }, async (url) => {
      requests.push(url);
      return new Blob(["image"], { type });
    });
    try {
      await new Promise(setImmediate);
      await nextTick();
      assert.equal(find(root, "img")?.props.alt, "photo");
      assert.match(find(root, "img")?.props.src, /^blob:/);
      assert.equal(textContent(find(root, "button")), "Download");
      assert.deepEqual(requests, ["/attachments?topic_id=topic&task_id=task&id=id&preview=1"]);
    } finally { app.unmount(); }
  });
}

for (const type of ["text/html", "image/svg+xml", "application/pdf", "application/octet-stream"]) {
  test(`received ${type} retains download without loading active content`, async () => {
    let calls = 0;
    const { root, app } = mountFile({ id: "id", name: "<script>.svg", content_type: type }, async () => { calls++; });
    try {
      await nextTick();
      assert.equal(canPreviewReceivedFile({ content_type: type }), false);
      assert.equal(find(root, "img"), null);
      assert.equal(find(root, "iframe"), null);
      assert.equal(textContent(find(root, "button")), "Download");
      assert.equal(find(root, "span")?.text, "<script>.svg");
      assert.equal(calls, 0);
    } finally { app.unmount(); }
  });
}

test("failed image preview leaves the download action and an explicit error", async () => {
  const { root, app } = mountFile({ id: "id", name: "image.png", content_type: "image/png" }, async () => { throw new Error("offline"); });
  try {
    await new Promise(setImmediate);
    await nextTick();
    assert.equal(find(root, "img"), null);
    assert.match(find(root, "p")?.text, /download/);
    assert.equal(textContent(find(root, "button")), "Download");
  } finally { app.unmount(); }
});

test("history reload retains attachment identity and owning conversation", () => {
  const attachment = { id: "opaque", name: "report.pdf", content_type: "application/octet-stream", size_bytes: 42 };
  const items = taskListHistoryItems([{ id: "task", topic_id: "topic", status: "done", attachments: [attachment] }], (key) => key);
  const agent = items.find((item) => item.role === "agent");
  assert.deepEqual(agent.attachments, [attachment]);
  assert.equal(agent.topicID, "topic");
  assert.equal(agent.taskId, "task");
  assert.equal(receivedFileURL("topic", "task", "opaque"), "/attachments?topic_id=topic&task_id=task&id=opaque");
});
