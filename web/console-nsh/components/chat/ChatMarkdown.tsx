// A reply's Markdown (the Vue console's MarkdownContent): nsh's TextView, with the console's prose
// sizes, a copy action on code blocks, and links opened outside the app.
import { TextView } from "nsh/base";
import { openExternal } from "../../lib/platform";

const CODE_ACTIONS = [{ id: "copy" }];

export function openChatLink(url: string) {
  const target = String(url || "").trim();
  if (!target || target.startsWith("#")) return;
  if (/^(https?:|mailto:)/i.test(target)) openExternal(target);
}

export function ChatMarkdown(props: { source: string; streaming?: boolean; class?: string; testID?: string }) {
  return (
    <TextView
      testID={props.testID}
      markdown={props.source}
      options={{ streaming: props.streaming === true }}
      selectable
      codeBlockActions={CODE_ACTIONS}
      onLinkPress={(event) => openChatLink(event.url)}
      class={`text-sm text-foreground ${props.class ?? ""}`}
      classes={{
        paragraph: "text-sm leading-6",
        heading1: "text-lg font-semibold",
        heading2: "text-base font-semibold",
        heading3: "text-sm font-semibold",
        code: "font-mono text-xs",
        codeBlock: "rounded-(--radius) border border-line-faint bg-paper",
      }}
    />
  );
}
