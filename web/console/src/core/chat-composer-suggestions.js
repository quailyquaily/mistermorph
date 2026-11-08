const COMPOSER_SUGGESTION_LIMIT = 8;

const COMPOSER_COMMAND_SUGGESTIONS = [
  {
    key: "command:help",
    type: "command",
    value: "/help",
    title: "/help",
    description: "Show available runtime commands.",
    insertText: "/help ",
  },
  {
    key: "command:stop",
    type: "command",
    value: "/stop",
    title: "/stop",
    description: "Stop the active task in this conversation.",
    insertText: "/stop ",
  },
  {
    key: "command:models",
    type: "command",
    value: "/models",
    title: "/models",
    description: "Show the current model profile.",
    insertText: "/models ",
  },
  {
    key: "command:skills",
    type: "command",
    value: "/skills",
    title: "/skills",
    description: "Show the currently loaded skills.",
    insertText: "/skills ",
  },
  {
    key: "command:ctx",
    type: "command",
    value: "/ctx",
    title: "/ctx",
    description: "Show context window usage for this conversation.",
    insertText: "/ctx ",
  },
  {
    key: "command:workspace",
    type: "command",
    value: "/workspace",
    title: "/workspace",
    description: "Show the current workspace directory.",
    insertText: "/workspace ",
  },
  {
    key: "command:think",
    type: "command",
    value: "/think",
    title: "/think <task>",
    description: "Run a task through the think LLM route.",
    insertText: "/think ",
  },
  {
    key: "command:ctx:compact",
    type: "command",
    value: "/ctx compact",
    title: "/ctx compact",
    description: "Compact older context into a checkpoint now.",
    insertText: "/ctx compact ",
  },
  {
    key: "command:models:list",
    type: "command",
    value: "/models list",
    title: "/models list",
    description: "List configured model profiles.",
    insertText: "/models list ",
  },
  {
    key: "command:models:set",
    type: "command",
    value: "/models set",
    title: "/models set <profile>",
    description: "Switch the current model profile.",
    insertText: "/models set ",
  },
  {
    key: "command:models:reset",
    type: "command",
    value: "/models reset",
    title: "/models reset",
    description: "Return model selection to automatic mode.",
    insertText: "/models reset ",
  },
  {
    key: "command:workspace:attach",
    type: "command",
    value: "/workspace attach",
    title: "/workspace attach <dir>",
    description: "Attach or replace the workspace directory.",
    insertText: "/workspace attach ",
  },
  {
    key: "command:workspace:detach",
    type: "command",
    value: "/workspace detach",
    title: "/workspace detach",
    description: "Detach the current workspace directory.",
    insertText: "/workspace detach ",
  },
];

function trimText(value) {
  return String(value || "").trim();
}

function composerTriggerContext(value, selectionStart) {
  const text = String(value || "");
  const cursor = Math.max(0, Math.min(Number(selectionStart) || 0, text.length));
  const beforeCursor = text.slice(0, cursor);
  const tokenStart = Math.max(
    beforeCursor.lastIndexOf(" "),
    beforeCursor.lastIndexOf("\n"),
    beforeCursor.lastIndexOf("\t")
  ) + 1;
  const token = beforeCursor.slice(tokenStart);
  if (token.length === 0) {
    return null;
  }
  const trigger = token.charAt(0);
  if (trigger !== "/" && trigger !== "$") {
    return null;
  }
  const query = token.slice(1);
  if (/\s/u.test(query)) {
    return null;
  }
  return {
    type: trigger === "/" ? "command" : "skill",
    trigger,
    query,
    start: tokenStart,
    end: cursor,
  };
}

function normalizeComposerSkillItems(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const id = trimText(item?.id);
    const name = trimText(item?.name);
    const value = id || name;
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      key: `skill:${key}`,
      type: "skill",
      value,
      title: `$${value}`,
      description: trimText(item?.description),
      insertText: `$${value} `,
    });
  }
  return out;
}

function commandKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/gu, ":").replace(/^\/+/u, "");
}

function composerSuggestionInsertText(value) {
  const text = String(value || "").trim();
  return text ? `${text} ` : "";
}

function normalizeComposerCommandItems(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const value = trimText(item?.value);
    if (!value.startsWith("/")) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const insertText = composerSuggestionInsertText(item?.insertText || item?.insert_text || value);
    if (!insertText) {
      continue;
    }
    out.push({
      key: `command:${commandKey(value)}`,
      type: "command",
      value,
      title: trimText(item?.title) || value,
      description: trimText(item?.description),
      insertText,
    });
  }
  return out;
}

function itemMatchesQuery(item, query) {
  const needle = trimText(query).toLowerCase();
  if (!needle) {
    return true;
  }
  return [item?.value, item?.title, item?.description]
    .some((value) => trimText(value).toLowerCase().includes(needle));
}

function buildComposerSuggestionItems({
  context,
  commands = COMPOSER_COMMAND_SUGGESTIONS,
  skills = [],
  limit = COMPOSER_SUGGESTION_LIMIT,
} = {}) {
  const type = String(context?.type || "");
  if (type !== "command" && type !== "skill") {
    return [];
  }
  const source = type === "command" && Array.isArray(commands) && commands.length > 0
    ? commands
    : type === "command"
      ? COMPOSER_COMMAND_SUGGESTIONS
      : skills;
  return source
    .filter((item) => itemMatchesQuery(item, context?.query))
    .slice(0, Math.max(0, Number(limit) || COMPOSER_SUGGESTION_LIMIT));
}

function replaceComposerSuggestionToken(value, range, insertText) {
  const text = String(value || "");
  const start = Math.max(0, Math.min(Number(range?.start) || 0, text.length));
  const end = Math.max(start, Math.min(Number(range?.end) || start, text.length));
  let before = text.slice(0, start);
  let after = text.slice(end);
  const insertion = composerSuggestionInsertText(insertText);
  if (insertion.endsWith(" ") && after.startsWith(" ")) {
    after = after.slice(1);
  }
  if (before.endsWith(" ") && insertion.startsWith(" ")) {
    before = before.slice(0, -1);
  }
  return `${before}${insertion}${after}`;
}

function composerTokenBoundary(text, index) {
  return index <= 0 || /\s/u.test(text.charAt(index - 1));
}

function composerTokenEnd(text, index) {
  let end = index;
  while (end < text.length && !/\s/u.test(text.charAt(end))) {
    end += 1;
  }
  return end;
}

function composerCommandHighlightCandidates(commands) {
  const source = Array.isArray(commands) && commands.length > 0
    ? commands
    : COMPOSER_COMMAND_SUGGESTIONS;
  return source
    .map((item) => trimText(item?.value))
    .filter((value) => value.startsWith("/"))
    .sort((a, b) => b.length - a.length)
    .map((value) => ({ value, lower: value.toLowerCase() }));
}

// Compares only the token's own characters, so a long draft is not lowercased once per "/".
function matchingComposerCommand(text, index, candidates) {
  for (const command of candidates) {
    const end = index + command.value.length;
    if (
      end <= text.length &&
      text.slice(index, end).toLowerCase() === command.lower &&
      (end >= text.length || /\s/u.test(text.charAt(end)))
    ) {
      return command.value;
    }
  }
  return "";
}

function appendComposerHighlightSegment(out, type, text) {
  if (!text) {
    return;
  }
  const previous = out[out.length - 1];
  if (previous?.type === type) {
    previous.text += text;
    return;
  }
  out.push({ type, text });
}

// Splits the draft into plain text and command/skill tokens for the composer's highlight layer.
// It jumps from one "/" or "$" to the next and builds the commands list once, so the work stays
// linear in the draft's length, even for long pasted text full of paths.
function composerHighlightSegments({
  text: rawText = "",
  commands = COMPOSER_COMMAND_SUGGESTIONS,
} = {}) {
  const text = String(rawText || "");
  const trigger = /[/$]/g;
  const out = [];
  let candidates = null;
  let plainStart = 0;
  let match = trigger.exec(text);
  while (match) {
    const start = match.index;
    if (!composerTokenBoundary(text, start)) {
      match = trigger.exec(text);
      continue;
    }
    const char = text.charAt(start);
    let end = -1;
    if (char === "/") {
      candidates = candidates || composerCommandHighlightCandidates(commands);
      const command = matchingComposerCommand(text, start, candidates);
      if (command) {
        end = start + command.length;
      }
    }
    if (end < 0) {
      end = composerTokenEnd(text, start);
    }
    appendComposerHighlightSegment(out, "text", text.slice(plainStart, start));
    appendComposerHighlightSegment(out, char === "/" ? "command" : "skill", text.slice(start, end));
    plainStart = end;
    trigger.lastIndex = Math.max(end, start + 1);
    match = trigger.exec(text);
  }
  appendComposerHighlightSegment(out, "text", text.slice(plainStart));
  return out.length ? out : [{ type: "text", text: "" }];
}

// The highlight layer only earns its cost when there is a token to color.
function composerHasHighlightTokens(segments) {
  return Array.isArray(segments) && segments.some((segment) => segment?.type !== "text");
}

export {
  COMPOSER_COMMAND_SUGGESTIONS,
  buildComposerSuggestionItems,
  composerHasHighlightTokens,
  composerHighlightSegments,
  composerSuggestionInsertText,
  composerTriggerContext,
  normalizeComposerCommandItems,
  normalizeComposerSkillItems,
  replaceComposerSuggestionToken,
};
