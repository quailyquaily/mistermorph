// A reply's Markdown (the Vue console's MarkdownContent.css and ChatView.css `.mmr-document`
// rules): nsh's TextView on the console's reading scale (16pt text in 27.2pt lines, headings
// 20/18/16), tables with a hairline frame and row rules but no cell grid, quotes with a blue rule on
// a faint fill, inline code on a light blue tint, and code blocks as one dark panel with the
// language at the top left and copy at the top right. Links open outside the app.
import { Image, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton, TextView, type TextViewCodeBlock } from "nsh/base";
import { ICONS } from "../icons";
import { pushNotice } from "../../lib/core/notices.js";
import { copyText, openExternal } from "../../lib/platform";
import { CODE_PANEL, CODE_TOKEN_COLORS, expandTabs, highlightCode } from "./codeHighlight";
import { t } from "./i18n";
import { inlineCopyText, linkInlineCode } from "./inlineCopy";

export function openChatLink(url: string) {
  const code = inlineCopyText(url);
  if (code !== null) {
    void copyInlineCode(code);
    return;
  }
  const target = String(url || "").trim();
  if (!target || target.startsWith("#")) return;
  if (/^(https?:|mailto:)/i.test(target)) openExternal(target);
}

// Inline code copies its text when pressed (inlineCopy.ts); a notice says it was copied, and only
// once it was.
async function copyInlineCode(code: string) {
  try {
    await copyText(code);
    pushNotice({ type: "success", text: t("chat_inline_code_copied", { code: code.length > 48 ? `${code.slice(0, 47)}…` : code }), timeout: 1600 });
  } catch {
    pushNotice({ type: "error", text: t("chat_inline_code_copy_failed") });
  }
}

// The Vue panel: code at 0.92 of the 14pt pre (12.88pt), in the pre's 1.62 lines of 14pt (22.68pt); padding 1.08em 1.12em, with
// 2.78em on top for the language and 3.35em on the right for copy (em of 14pt).
const CODE_SIZE = 12.88;
const CODE_LINE = 22.68;

function tokenColor(kind: string) {
  return kind === "plain" ? CODE_PANEL.text : CODE_TOKEN_COLORS[kind as keyof typeof CODE_TOKEN_COLORS];
}

function CodeBlock(props: { block: TextViewCodeBlock; copyLabel: string }) {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const language = () => String(props.block.language ?? "").trim();
  const tokens = () => highlightCode(expandTabs(String(props.block.code ?? "")), language());
  const copy = () => {
    void copyText(String(props.block.code ?? ""));
    copied.set(true);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => copied.set(false), 1400);
  };
  return (
    <View class="group my-1.5 rounded-(--radius)" style={{ backgroundColor: CODE_PANEL.background }} testID="chat-code-block">
      <Scroll horizontal scrollbar={false}>
        <View selectable style={{ paddingTop: 38.9, paddingBottom: 15.1, paddingLeft: 15.7, paddingRight: 46.9 }}>
          <Text class="font-mono" style={{ fontSize: CODE_SIZE, lineHeight: CODE_LINE, color: CODE_PANEL.text }}>
            <Each of={tokens()}>{(token) => <Text style={{ color: tokenColor(token().kind) }}>{token().text}</Text>}</Each>
          </Text>
        </View>
      </Scroll>
      <If when={language()}>
        <Text class="absolute left-3.5 top-3 font-mono text-xs" style={{ color: CODE_PANEL.muted }} accessibilityElementsHidden>
          {language()}
        </Text>
      </If>
      <BaseButton
        onPress={copy}
        accessibilityLabel={props.copyLabel}
        testID="chat-code-copy"
        class="absolute right-2.5 top-2.5 size-7 items-center justify-center rounded-(--radius) opacity-0 transition duration-150 group-hover:opacity-100 focus:opacity-100 hover:bg-[#34344b]"
      >
        <Image
          src={copied() ? ICONS.PhCheck : ICONS.PhCopy}
          accessibilityElementsHidden
          style={{ width: 14, height: 14, tintColor: copied() ? CODE_PANEL.bright : CODE_PANEL.muted }}
        />
      </BaseButton>
    </View>
  );
}

export function ChatMarkdown(props: { source: string; streaming?: boolean; class?: string; testID?: string; copyLabel?: string }) {
  return (
    <TextView
      testID={props.testID}
      markdown={linkInlineCode(props.source)}
      options={{ streaming: props.streaming === true }}
      selectable
      renderCodeBlock={(block) => <CodeBlock block={block} copyLabel={props.copyLabel ?? "Copy"} />}
      onLinkPress={(event) => openChatLink(event.url)}
      class={`text-base text-foreground ${props.class ?? ""}`}
      classes={{
        root: "gap-2.5 leading-[27.2px]",
        paragraph: "text-base leading-[27.2px]",
        heading1: "text-xl font-semibold",
        heading2: "text-lg font-semibold tracking-[-0.02em]",
        heading3: "text-base font-semibold",
        heading4: "text-base font-semibold",
        // Its own ink and no underline, so inline code pressed to copy (a link around it) does not
        // read as a link.
        code: "font-mono text-[14px] text-foreground no-underline bg-selection",
        strong: "font-semibold",
        blockquote: "border-l-[3px] border-blue/45 bg-hover-soft py-[12.8px] pl-4 pr-4 text-foreground",
        list: "gap-[3.5px]",
        table: "max-w-full self-start border-r border-line-soft",
        tableHead: "bg-line/12",
        tableCell: "border-r-0 border-b-line/31 px-[11.5px] py-[9.3px] text-base leading-[27.2px] text-foreground",
        tableHeaderCell: "border-b-line-soft font-semibold",
        link: "text-blue",
      }}
    />
  );
}
