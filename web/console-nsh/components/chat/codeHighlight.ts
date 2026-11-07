// Code for the chat's dark code panel (the Vue console's MarkdownContent.css): tabs expanded to tab
// stops, and a small highlighter in GitHub's dark palette.
//
// Why not TextView's own code blocks: they draw on the theme's light `muted` fill with the light
// syntax palette, and nsh has no way to give one subtree the dark appearance, so a dark panel needs
// its own colours. And a tab character is drawn by the web backend's text runs at a width its
// layout does not know, so tab-indented code (Go) overlapped itself ("delay 200 *=" drawn over
// "time.Millisecond"); spaces lay out the same everywhere.
//
// The highlighter is deliberately small (comments, strings, numbers, keywords, calls, types): a
// reply's code is short, and this runs in the interpreter on every streamed chunk of the block.

/** Columns between tab stops: the browser's default `tab-size`, which the Vue console keeps. */
export const TAB_SIZE = 8;

/** `text` with each tab replaced by the spaces up to the next tab stop. */
export function expandTabs(text: string, size = TAB_SIZE) {
  if (!text.includes("\t")) return text;
  let out = "";
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const spaces = size - (column % size);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += ch;
      column = ch === "\n" ? 0 : column + 1;
    }
  }
  return out;
}

export type CodeTokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "function" | "type";

export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

/** The panel's colours (the Vue console's --md-code-* and github-dark's token colours). The panel
 * is dark in both appearances, as in the Vue console, so these are not theme tokens. */
export const CODE_PANEL = {
  background: "#1b1f3b",
  surface: "#34344b",
  text: "#c9d1d9",
  muted: "#8b949e",
  bright: "#f0f6fc",
} as const;

export const CODE_TOKEN_COLORS: Record<Exclude<CodeTokenKind, "plain">, string> = {
  comment: "#8b949e",
  string: "#a5d6ff",
  number: "#79c0ff",
  keyword: "#ff7b72",
  function: "#d2a8ff",
  type: "#ffa657",
};

const KEYWORDS = new Set(
  (
    "as async await break case catch chan class const continue def default defer del do elif else enum " +
    "except export extends false fallthrough final finally fn for from func function go goto if impl " +
    "import in interface is lambda let loop match mod module mut new nil none null package pass pub raise " +
    "range return select self static struct super switch this throw trait true try type typeof undefined " +
    "use var void where while with yield None True False Self"
  ).split(" "),
);

const HASH_COMMENT_LANGUAGES = new Set([
  "sh", "bash", "zsh", "shell", "console", "python", "py", "yaml", "yml", "toml", "ruby", "rb", "perl", "r",
  "dockerfile", "makefile", "make", "conf", "ini", "nginx", "elixir", "ex", "powershell", "ps1",
]);

const DASH_COMMENT_LANGUAGES = new Set(["sql", "lua", "haskell", "hs"]);

/** The tokens of `code` (tabs already expanded), for a language named by a fence's info string. */
export function highlightCode(code: string, language?: string): CodeToken[] {
  const lang = String(language || "").trim().toLowerCase();
  const hash = HASH_COMMENT_LANGUAGES.has(lang);
  const dash = DASH_COMMENT_LANGUAGES.has(lang);
  const parts = [
    "(\\/\\*[\\s\\S]*?(?:\\*\\/|$)|\\/\\/[^\\n]*" + (hash ? "|#[^\\n]*" : "") + (dash ? "|--[^\\n]*" : "") + ")",
    "(\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?|`[^`]*`?)",
    "(\\b0[xX][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)",
    "([A-Za-z_$][\\w$]*)",
  ];
  const re = new RegExp(parts.join("|"), "g");
  const tokens: CodeToken[] = [];
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ kind: "plain", text: plain });
    plain = "";
  };
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    if (match[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    plain += code.slice(last, match.index);
    last = match.index + match[0].length;
    let kind: CodeTokenKind = "plain";
    if (match[1] !== undefined) kind = "comment";
    else if (match[2] !== undefined) kind = "string";
    else if (match[3] !== undefined) kind = "number";
    else if (match[4] !== undefined) {
      const word = match[4];
      if (KEYWORDS.has(word)) kind = "keyword";
      else if (/^\s*\(/.test(code.slice(last, last + 8))) kind = "function";
      else if (/^[A-Z][a-z0-9]/.test(word) && word.length > 1) kind = "type";
    }
    if (kind === "plain") {
      plain += match[0];
      continue;
    }
    flush();
    tokens.push({ kind, text: match[0] });
  }
  plain += code.slice(last);
  flush();
  return tokens;
}
