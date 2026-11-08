import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_COMMAND_SUGGESTIONS,
  buildComposerSuggestionItems,
  composerHasHighlightTokens,
  composerHighlightSegments,
  composerSuggestionInsertText,
  composerTriggerContext,
  normalizeComposerCommandItems,
  normalizeComposerSkillItems,
  replaceComposerSuggestionToken,
} from "./chat-composer-suggestions.js";

test("composerTriggerContext detects slash and skill tokens at the cursor", () => {
  assert.deepEqual(composerTriggerContext("/", 1), {
    type: "command",
    trigger: "/",
    query: "",
    start: 0,
    end: 1,
  });
  assert.deepEqual(composerTriggerContext("ask /pla", 8), {
    type: "command",
    trigger: "/",
    query: "pla",
    start: 4,
    end: 8,
  });
  assert.deepEqual(composerTriggerContext("use $imagegen", 13), {
    type: "skill",
    trigger: "$",
    query: "imagegen",
    start: 4,
    end: 13,
  });

  assert.equal(composerTriggerContext("plain/", 6), null);
  assert.equal(composerTriggerContext("/plan now", 9), null);
});

test("normalizeComposerSkillItems dedupes skills and prefers ids for insertion", () => {
  const items = normalizeComposerSkillItems([
    { id: "imagegen", name: "Image Gen", description: "Create images" },
    { id: "imagegen", name: "Duplicate", description: "ignored" },
    { id: "", name: "openai-docs", description: "Docs" },
    null,
  ]);

  assert.deepEqual(items, [
    {
      key: "skill:imagegen",
      type: "skill",
      value: "imagegen",
      title: "$imagegen",
      description: "Create images",
      insertText: "$imagegen ",
    },
    {
      key: "skill:openai-docs",
      type: "skill",
      value: "openai-docs",
      title: "$openai-docs",
      description: "Docs",
      insertText: "$openai-docs ",
    },
  ]);
});

test("normalizeComposerCommandItems accepts backend command payloads", () => {
  const items = normalizeComposerCommandItems([
    {
      value: "/models list",
      title: "/models list",
      description: "List model profiles",
      insert_text: "/models list ",
    },
    {
      value: "/models list",
      title: "Duplicate",
      description: "ignored",
      insert_text: "/models list ",
    },
    {
      value: "/workspace attach",
      title: "/workspace attach <dir>",
      description: "Attach workspace",
    },
    {
      value: "review",
      title: "not a slash command",
    },
    null,
  ]);

  assert.deepEqual(items, [
    {
      key: "command:models:list",
      type: "command",
      value: "/models list",
      title: "/models list",
      description: "List model profiles",
      insertText: "/models list ",
    },
    {
      key: "command:workspace:attach",
      type: "command",
      value: "/workspace attach",
      title: "/workspace attach <dir>",
      description: "Attach workspace",
      insertText: "/workspace attach ",
    },
  ]);
});

test("buildComposerSuggestionItems filters command and skill candidates", () => {
  const skills = normalizeComposerSkillItems([
    { id: "imagegen", name: "Image Gen", description: "Create images" },
    { id: "openai-docs", name: "OpenAI Docs", description: "API reference" },
  ]);

  const commandItems = buildComposerSuggestionItems({
    context: { type: "command", query: "mod" },
    skills,
  });
  assert.equal(commandItems[0].insertText, "/models ");
  assert.ok(commandItems.every((item) => item.type === "command"));

  const skillItems = buildComposerSuggestionItems({
    context: { type: "skill", query: "imag" },
    skills,
  });
  assert.deepEqual(skillItems.map((item) => item.value), ["imagegen"]);
});

test("buildComposerSuggestionItems can use commands loaded from the backend", () => {
  const commands = normalizeComposerCommandItems([
    { value: "/custom", title: "/custom", description: "Backend command", insert_text: "/custom " },
  ]);

  const commandItems = buildComposerSuggestionItems({
    context: { type: "command", query: "cus" },
    commands,
  });

  assert.deepEqual(commandItems.map((item) => item.value), ["/custom"]);
});

test("composer command suggestions are backed by runtime commands", () => {
  const values = COMPOSER_COMMAND_SUGGESTIONS.map((item) => item.value);

  assert.deepEqual(values.slice(0, 7), [
    "/help",
    "/stop",
    "/models",
    "/skills",
    "/ctx",
    "/workspace",
    "/think",
  ]);
  assert.ok(values.includes("/ctx compact"));
  assert.ok(values.includes("/models list"));
  assert.ok(values.includes("/workspace attach"));
  assert.equal(values.includes("/plan"), false);
  assert.equal(values.includes("/review"), false);
  assert.equal(values.includes("/fix"), false);
  assert.ok(COMPOSER_COMMAND_SUGGESTIONS.every((item) => item.insertText.endsWith(" ")));
});

test("replaceComposerSuggestionToken replaces the active token without doubling spaces", () => {
  const suggestion = COMPOSER_COMMAND_SUGGESTIONS.find((item) => item.value === "/think");
  assert.ok(suggestion);

  assert.equal(
    replaceComposerSuggestionToken("ask /thi later", { start: 4, end: 8 }, suggestion.insertText),
    "ask /think later"
  );
  assert.equal(
    replaceComposerSuggestionToken("$img", { start: 0, end: 4 }, "$imagegen "),
    "$imagegen "
  );
});

test("composer suggestion insertion always keeps one trailing space", () => {
  assert.equal(composerSuggestionInsertText("/think"), "/think ");
  assert.equal(composerSuggestionInsertText("$imagegen "), "$imagegen ");
  assert.equal(composerSuggestionInsertText(""), "");

  assert.equal(
    replaceComposerSuggestionToken("ask /thi later", { start: 4, end: 8 }, "/think"),
    "ask /think later"
  );
  assert.equal(
    replaceComposerSuggestionToken("$img", { start: 0, end: 4 }, "$imagegen"),
    "$imagegen "
  );
});

test("composerHighlightSegments marks slash commands and skill tokens", () => {
  const commands = normalizeComposerCommandItems([
    { value: "/models list", title: "/models list", insert_text: "/models list " },
    { value: "/think", title: "/think", insert_text: "/think " },
  ]);
  const skills = normalizeComposerSkillItems([
    { id: "imagegen", name: "Image Gen" },
  ]);

  assert.deepEqual(
    composerHighlightSegments({
      text: "/models list with $imagegen and plain/",
      commands,
      skills,
    }),
    [
      { type: "command", text: "/models list" },
      { type: "text", text: " with " },
      { type: "skill", text: "$imagegen" },
      { type: "text", text: " and plain/" },
    ]
  );

  assert.deepEqual(
    composerHighlightSegments({ text: "ask /thi then $ope" }),
    [
      { type: "text", text: "ask " },
      { type: "command", text: "/thi" },
      { type: "text", text: " then " },
      { type: "skill", text: "$ope" },
    ]
  );
});

// The reference the faster segmenter must agree with: one character at a time, as it was.
function referenceSegments(text, commands = COMPOSER_COMMAND_SUGGESTIONS) {
  const values = commands.map((item) => String(item.value).trim()).filter((value) => value.startsWith("/"))
    .sort((a, b) => b.length - a.length);
  const out = [];
  const push = (type, value) => {
    if (!value) return;
    const previous = out[out.length - 1];
    if (previous?.type === type) previous.text += value;
    else out.push({ type, text: value });
  };
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const boundary = index === 0 || /\s/u.test(text.charAt(index - 1));
    if ((char !== "/" && char !== "$") || !boundary) {
      push("text", char);
      index += 1;
      continue;
    }
    if (char === "/") {
      const command = values.find((value) => text.slice(index, index + value.length).toLowerCase() === value.toLowerCase() &&
        (index + value.length >= text.length || /\s/u.test(text.charAt(index + value.length))));
      if (command) {
        push("command", text.slice(index, index + command.length));
        index += command.length;
        continue;
      }
    }
    let end = index;
    while (end < text.length && !/\s/u.test(text.charAt(end))) end += 1;
    push(char === "/" ? "command" : "skill", text.slice(index, end));
    index = end;
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

test("composerHighlightSegments matches the character-by-character reference", () => {
  const samples = [
    "",
    "plain text only",
    "/help",
    "/HELP me",
    "/models list\n/models  list",
    "a/b c /x/y $skill$more\t$ /",
    "  if (x) { open('/usr/lib', $HOME); } // see /help\n",
    "/ctx compact now and /ctx\n$imagegen",
    "日本語 /help 中文 $技能",
  ];
  for (const text of samples) {
    assert.deepEqual(composerHighlightSegments({ text }), referenceSegments(text), JSON.stringify(text));
  }
  const commands = normalizeComposerCommandItems([{ value: "/models list" }, { value: "/think" }]);
  const text = "/models list then /think and /models";
  assert.deepEqual(composerHighlightSegments({ text, commands }), referenceSegments(text, commands));
});

test("composerHighlightSegments keeps a large multiline paste intact in linear work", () => {
  const line = "  at open (/usr/local/lib/app.js:12:3) then $HOME and /help\n";
  const text = line.repeat(4000);
  const lowered = { chars: 0 };
  const lowerCase = String.prototype.toLowerCase;
  String.prototype.toLowerCase = function toLowerCase() {
    lowered.chars += this.length;
    return lowerCase.call(this);
  };
  let segments;
  try {
    segments = composerHighlightSegments({ text });
  } finally {
    String.prototype.toLowerCase = lowerCase;
  }
  // Every character survives, in order: highlighting never changes the draft.
  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.ok(composerHasHighlightTokens(segments));
  // Only command-sized pieces at each token are lowercased, never the whole draft once per "/":
  // the old segmenter lowercased the full text for every slash token, here about 8000 times.
  assert.ok(lowered.chars < 4 * text.length, `lowercased ${lowered.chars} chars for a ${text.length}-char draft`);
});

test("composerHasHighlightTokens is true only when a command or skill token is present", () => {
  assert.equal(composerHasHighlightTokens(composerHighlightSegments({ text: "" })), false);
  assert.equal(composerHasHighlightTokens(composerHighlightSegments({ text: "a/b and c$d\nplain" })), false);
  assert.equal(composerHasHighlightTokens(composerHighlightSegments({ text: "run /help" })), true);
  assert.equal(composerHasHighlightTokens(composerHighlightSegments({ text: "use $skill" })), true);
  assert.equal(composerHasHighlightTokens(null), false);
});
