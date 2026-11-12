// The terminal's typed text (the detail panel's dark terminal, ChatTerminal.tsx): a run's values
// and output drawn as a dashboard's readout, each kind of term in its own neon on the dark ink.
//
//   URLs           cyan      copy on press
//   IDs            magenta   copy on press (UUIDs, prefixed ids such as task_8f3k2l, hex hashes)
//   paths          amber     copy on press
//   numbers        green     (values only)
//   true/false/null orange   (values only)
//
// A pressed term is copied whole and flashes green with a check for a moment. Output and errors
// mark only the terms worth copying (`copyOnly`): a table of figures in neon would be noise.
//
// `StatusTag` is a run's state as a bracketed mono tag ([DONE] [RUN ] [FAIL] [STOP] [WAIT]), and
// `KindChip` an entry's kind as a small outlined chip.
import { signal, Text } from "nsh";
import { copyText } from "../../lib/platform";
import { t } from "./i18n";

export const NEON = {
  cyan: "#5ce1e6",
  magenta: "#ff7edb",
  violet: "#b39dff",
  amber: "#f5c56b",
  green: "#7ee787",
  orange: "#ffa657",
  ok: "#3ddc97",
  run: "#f5a524",
  fail: "#ff5c7a",
  idle: "#8b93b8",
  key: "#7d89b8",
} as const;

export type TermKind = "url" | "id" | "path" | "number" | "literal" | "plain";

export interface Term {
  kind: TermKind;
  text: string;
}

const COLOR: Record<Exclude<TermKind, "plain">, string> = {
  url: NEON.cyan,
  id: NEON.magenta,
  path: NEON.amber,
  number: NEON.green,
  literal: NEON.orange,
};

const COPYABLE = new Set<TermKind>(["url", "id", "path"]);

// One pass over the text, the kinds in order of precedence at a position: a URL before the path
// inside it, a UUID before the hex runs inside it.
const PATTERN = new RegExp(
  [
    /(https?:\/\/[^\s"'`<>()[\]{}]*[^\s"'`<>()[\]{}.,;:!?])/.source,
    /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/.source,
    /\b([A-Za-z]{1,16}[_-](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,})\b/.source,
    /\b((?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,64})\b/.source,
    /((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)*\/?)/.source,
    /\b(\d+(?:\.\d+)?(?:ms|s|m|h|KB|MB|GB|kb|mb|gb|%)?)\b/.source,
    /\b(true|false|null|nil|none|undefined)\b/.source,
  ].join("|"),
  "g",
);
const KINDS: TermKind[] = ["url", "id", "id", "id", "path", "number", "literal"];
// A path starts a word: at the start, after a space, a quote, `=`, `:` or an opening bracket.
const PATH_BEFORE = /[\s"'`=:([{,]/;

/** The text as terms. `copyOnly` keeps only the kinds worth copying (output and errors). */
export function terminalTerms(text: string, options: { copyOnly?: boolean } = {}): Term[] {
  const terms: Term[] = [];
  let plainFrom = 0;
  const pushPlain = (until: number) => {
    if (until > plainFrom) terms.push({ kind: "plain", text: text.slice(plainFrom, until) });
  };
  PATTERN.lastIndex = 0;
  for (let match = PATTERN.exec(text); match; match = PATTERN.exec(text)) {
    const group = match.slice(1).findIndex((value) => value !== undefined);
    const kind = KINDS[group];
    const at = match.index;
    if (kind === "path" && at > 0 && !PATH_BEFORE.test(text[at - 1])) continue;
    // A lone "/" or a bare "./" is not a path worth a colour.
    if (kind === "path" && match[0].replace(/[~./]/g, "") === "") continue;
    if (options.copyOnly && !COPYABLE.has(kind)) continue;
    pushPlain(at);
    terms.push({ kind, text: match[0] });
    plainFrom = at + match[0].length;
  }
  pushPlain(text.length);
  return terms;
}

/**
 * At most `limit` characters of terms: plain text is cut (with "..."), a term worth copying is
 * kept whole or left out, so a press never copies part of one.
 */
export function limitTerms(terms: Term[], limit: number): Term[] {
  const out: Term[] = [];
  let used = 0;
  for (const term of terms) {
    if (used + term.text.length <= limit) {
      out.push(term);
      used += term.text.length;
      continue;
    }
    if (!COPYABLE.has(term.kind)) out.push({ ...term, text: term.text.slice(0, Math.max(0, limit - used)) });
    out.push({ kind: "plain", text: "..." });
    break;
  }
  return out;
}

const COPIED_MS = 1200;

/**
 * Typed text on the terminal: its terms coloured by kind, the ones worth copying pressable. `class`
 * styles the whole run (its size, font and the plain text's colour).
 */
export function TerminalText(props: { text: string; class?: string; copyOnly?: boolean; limit?: number; testID?: string }) {
  const copied = signal(-1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terms = () => {
    const all = terminalTerms(props.text, { copyOnly: props.copyOnly });
    return props.limit ? limitTerms(all, props.limit) : all;
  };
  const copy = (index: number, text: string) => {
    void copyText(text);
    copied.set(index);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => copied.set(-1), COPIED_MS);
  };
  return (
    <Text class={props.class} testID={props.testID}>
      {/* By position: streamed output changes its terms in place. */}
      <Each of={terms()} key="index">
        {(term, index) => (
          <If when={term().kind !== "plain"} else={<Text>{term().text}</Text>}>
            <If
              when={COPYABLE.has(term().kind)}
              else={<Text style={{ color: COLOR[term().kind as Exclude<TermKind, "plain">] }}>{term().text}</Text>}
            >
              <Text
                role="button"
                accessibilityLabel={`${t("action_copy")} ${term().text}`}
                onPress={() => copy(index(), term().text)}
                class="hover:underline"
                style={{
                  color: copied() === index() ? NEON.ok : COLOR[term().kind as Exclude<TermKind, "plain">],
                  backgroundColor: copied() === index() ? "rgba(61, 220, 151, 0.14)" : undefined,
                }}
                testID={`terminal-copy-${term().kind}`}
              >
                {term().text}
                {copied() === index() ? " ✓" : ""}
              </Text>
            </If>
          </If>
        )}
      </Each>
    </Text>
  );
}

/** A run's state as the tag the terminal shows, and its colour. */
export function statusTag(status: string): { label: string; color: string } {
  switch (status) {
    case "done":
    case "completed":
      return { label: "DONE", color: NEON.ok };
    case "running":
    case "in_progress":
      return { label: "RUN ", color: NEON.run };
    case "failed":
      return { label: "FAIL", color: NEON.fail };
    case "canceled":
      return { label: "STOP", color: NEON.fail };
    default:
      return { label: "WAIT", color: NEON.idle };
  }
}

/** `[DONE]`: mono 11, the brackets dim, the state in its colour. */
export function StatusTag(props: { status: string; testID?: string }) {
  const tag = () => statusTag(props.status);
  return (
    <Text class="font-mono text-[11px] leading-[18px]" accessibilityLabel={tag().label.trim()} testID={props.testID}>
      <Text style={{ color: NEON.idle }}>[</Text>
      <Text style={{ color: tag().color }}>{tag().label}</Text>
      <Text style={{ color: NEON.idle }}>]</Text>
    </Text>
  );
}

/** An entry's kind (TOOL, SUBTASK, CODER…): a small outlined mono chip in its own colour. */
export function KindChip(props: { label: string; tone?: "cyan" | "violet" | "idle" }) {
  const color = () => (props.tone === "violet" ? NEON.violet : props.tone === "idle" ? NEON.idle : NEON.cyan);
  return (
    <Text
      class="rounded-[2px] border px-1 font-mono text-[10px] uppercase leading-[14px] tracking-[0.08em]"
      style={{ color: color(), borderColor: `${color()}66` }}
    >
      {props.label}
    </Text>
  );
}
