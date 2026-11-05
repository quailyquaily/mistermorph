import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [todoCSS, sharedCSS, todoView, chatView] = await Promise.all(
  ["TodoView.css", "common.css", "TodoView.js", "ChatView.js"].map((file) =>
    readFile(new URL(`../views/${file}`, import.meta.url), "utf8")
  )
);

test("Scheduled follows Chat's list inset on mobile and keeps the desktop gutter", () => {
  // Chat gets its outer inset from the enclosing list. Todo's heading is outside its list.
  assert.match(sharedCSS, /\.workspace-sidebar-section \{[^}]*--workspace-sidebar-list-pad: var\(--workspace-sidebar-list-gutter\);/u);
  assert.match(sharedCSS, /\.workspace-sidebar-list \{[^}]*padding: var\(--workspace-sidebar-list-pad\);/u);
  assert.match(todoCSS, /\n\.todo-index-divider \{\s*margin-inline: var\(--workspace-sidebar-list-gutter\);\s*\}/u);

  const mobileShared = sharedCSS.match(/@media \(max-width: 920px\) \{\n((?:[^{}]|\{[^{}]*\})*)\n\}/u)?.[1];
  const mobileTodo = [...todoCSS.matchAll(/@media \(max-width: 920px\) \{\n((?:[^{}]|\{[^{}]*\})*)\n\}/gu)]
    .map((match) => match[1]).join("\n");
  assert.match(mobileShared, /\.page-view \.workspace-sidebar-section \{\s*--workspace-sidebar-list-pad: var\(--workspace-sidebar-list-gutter\) 0;\s*\}/u);
  assert.match(mobileTodo, /\.todo-index-divider \{\s*margin-inline: 0;\s*\}/u);
  assert.equal(todoCSS.match(/\.todo-index-divider\s*\{/gu)?.length, 2);
});

test("Scheduled shares Chat's label and rule geometry for populated and empty lists", () => {
  assert.match(chatView, /chat-topic-list workspace-sidebar-list[^]*?<section[^]*?<h4 v-else-if="group.label" class="chat-topic-day-label workspace-sidebar-divider">\s*<span class="chat-topic-day-label-text workspace-sidebar-divider-label">/u);
  assert.match(todoView, /<section class="todo-index-group todo-task-group">\s*<h4 v-if="tasks.length > 0 \|\| !loading" class="todo-index-divider workspace-sidebar-divider">\s*<span class="workspace-sidebar-divider-label">[^]*?<\/h4>\s*<div\s+v-if="tasks.length > 0"/u);
  assert.match(todoView, /<div v-else-if="!loading" class="todo-index-items workspace-sidebar-list">\s*<button[^>]*class="workspace-sidebar-item todo-empty-item"/u);
  assert.doesNotMatch(todoCSS, /\.todo-index-divider(?:::after|\s+\.workspace-sidebar-divider-label)\s*\{/u);
});
