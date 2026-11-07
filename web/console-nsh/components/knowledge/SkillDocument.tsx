// SKILL.md as the Skills page and the Skill Store show it (Vue: MarkdownContent inside
// .skills-doc / .store-doc). The document reads in console colours at the renderer's 13pt with
// 1.72 lines, and its headings sit a step below the skill's own name (h1 20pt, h2 18pt), so the
// file does not read as a second page title. Inline code keeps the renderer's warm chip; tables
// are ruled with the soft hairline, their head tinted.
import { TextView } from "nsh/base";

export function SkillDocument(props: { source: string; onLinkPress?: (url: string) => void; testID?: string }) {
  return (
    <TextView
      testID={props.testID}
      markdown={props.source}
      selectable
      onLinkPress={props.onLinkPress ? (event) => props.onLinkPress?.(event.url) : undefined}
      codeBlockScrollbar
      tableScrollbar
      class="text-[13px] leading-[22.36px] text-foreground"
      classes={{
        root: "gap-3",
        paragraph: "text-[13px] leading-[22.36px]",
        heading: "font-semibold text-foreground",
        heading1: "text-xl leading-[23.6px] tracking-[-0.02em]",
        heading2: "mt-3 text-lg leading-[21.2px] tracking-[-0.02em]",
        heading3: "mt-2 text-base leading-[20.0px]",
        heading4: "text-sm",
        code: "font-mono text-[11.375px] bg-[#f5f0e8]",
        strong: "font-semibold",
        list: "gap-0",
        listItem: "text-[13px] leading-[22.36px]",
        blockquote: "border-l-2 border-line-soft bg-blue/4 py-2 pl-3 pr-3",
        table: "self-stretch border border-line-soft",
        tableHead: "bg-line/12",
        tableCell: "border-line-soft/60 px-[9.36px] py-[7.54px] text-[13px] leading-[22.36px] text-foreground",
        tableHeaderCell: "border-line-soft font-semibold text-foreground",
        link: "text-blue",
        rule: "bg-line-soft",
      }}
    />
  );
}
