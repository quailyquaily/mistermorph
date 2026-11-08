// The TODO page's editor card: the Vue console's boxed AppSection (components/AppSection.css
// `.app-section.is-boxed`) as the TODO page uses it, with a lead slot (the task editor's switch)
// that ui.tsx's Section does not have. A hairline frame on the paper; the head is the frame's top
// strip, 48pt, on its own hairline: a mono caps label, the meta on one line, the actions at the far
// end one control high. In the calendar's side column it is a panel instead (TodoView.css: a white
// card with 8pt corners and a soft shadow, without the frame), as Chat's right pane is.
import type { JSX } from "nsh";
import { Text, View, windowSize } from "nsh";
import { FadeText } from "../motion";

/** AppSection's padding: 16, 12 under a 720 window. */
export const cardPadding = () => (windowSize().width <= 720 ? 12 : 16);

const PANEL_SHADOW = "0 1px 4px rgba(24, 24, 50, 0.07)";

export function TodoCard(props: {
  title?: string;
  meta?: string;
  /** Before the label, on the head's left edge (the task editor's switch). */
  lead?: JSX.Element;
  /** The right end of the head: plain xs buttons and menus, one control (32pt) high. */
  actions?: JSX.Element;
  /** panel: the calendar's side column (white, rounded, shadowed, unframed). */
  panel?: boolean;
  /** is-list: the body is a list of padded rows, so it keeps only 4pt above and below. */
  list?: boolean;
  /** The body takes the rest of the card's height (the heartbeat's editor). */
  fill?: boolean;
  class?: string;
  bodyClass?: string;
  testID?: string;
  accessibilityLabel?: string;
  children?: JSX.Element;
}) {
  const hasHead = () => !!(props.title || props.meta || props.lead || props.actions);
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class={`${props.panel ? "rounded-lg bg-card" : "rounded-(--radius) border border-line-soft bg-paper-soft"} ${
        props.fill ? "flex-1" : ""
      } ${props.class ?? ""}`}
      style={props.panel ? { boxShadow: PANEL_SHADOW } : undefined}
    >
      <If when={hasHead()}>
        <View class="h-12 flex-row items-center gap-2.5 border-b border-line-soft" style={{ paddingHorizontal: cardPadding() }}>
          <If when={props.lead}>
            <View class="-mr-1 h-8 flex-row items-center">{props.lead}</View>
          </If>
          <If when={props.title}>
            <Text
              role="header"
              class="font-mono text-[11px] font-semibold uppercase leading-[15.4px] tracking-[1.1px] text-subtle line-clamp-1"
            >
              {props.title}
            </Text>
          </If>
          <View class="flex-1">
            <If when={props.meta}>
              <FadeText text={props.meta ?? ""} class="text-xs leading-[17.4px] text-muted-foreground" />
            </If>
          </View>
          <If when={props.actions}>
            <View class="-mr-1.5 h-8 flex-row items-center gap-1">{props.actions}</View>
          </If>
        </View>
      </If>
      <View
        class={`${props.fill ? "flex-1" : ""} ${props.bodyClass ?? ""}`}
        style={{ paddingHorizontal: cardPadding(), paddingVertical: props.list ? 4 : cardPadding() }}
      >
        {props.children}
      </View>
    </View>
  );
}
