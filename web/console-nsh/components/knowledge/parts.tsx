// The parts Skills, the Skill Store, Memories and Contacts share: the workspace index column (the
// Vue console's workspace-sidebar-section), its rows and group dividers, the boxed section a page
// shows its picked item in (AppSection variant="boxed"), its property list (ui-property-list), the
// inline notice (AppNotice), the phone bar with its back button, the search field, and the index
// search that Topics and Contacts share.
//
// Metrics are the Vue console's (views/common.css, components/AppSection.css, the pages' CSS):
// CSS px are points here. The index column sits on the page paper with no frame of its own, a
// 57pt head with the page's title in the 20pt title face, then a list padded 16pt whose rows are
// padded 12/13/11/14. The selected row is a soft fill that glides between rows (one highlight,
// components/motion's sliding selection); a row's hover fill comes in after 60 ms and goes at once,
// so sweeping the pointer down a list does not flash every row it passes.
import type { InputRef, JSX } from "nsh";
import { cleanup, effect, keymap, Scroll, signal, Text, View, windowSize } from "nsh";
import { Button as BaseButton, Switch } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { isMobile } from "../../lib/shell";
import { onSystemBack } from "../../lib/systemBack";
import { createScrollEdges, FadeText, MOTION_EASE_CSS, MOTION_NORMAL, motionMs, SCROLLBAR } from "../motion";
import { BackButton, BAR_ICON_SIZE, CircleButton, Icon, TextField, type IconName } from "../ui";
import type { PartLayoutListener } from "../shared/partProbe";
import { MobileBarSpacer } from "../frame/mobileBar";
import { listTitleSize } from "../frame/metrics";

/** translate with its variables typed (the JS default `vars = null` reads as `null` only). */
export const t = translate as unknown as (key: string, vars?: Record<string, unknown>) => string;

/** The page's side gutter (the Vue console's --content-gutter-x: clamp(16px, 2vw, 28px), 14 on
 * tablets, 12 on phones). */
export function gutterX() {
  const width = windowSize().width;
  if (width <= 620) return 12;
  if (width <= 980) return 14;
  return Math.min(28, Math.max(16, width * 0.02));
}

/** The page's vertical gutter (--content-gutter-y: clamp(12px, 1.4vw, 20px), 12 / 10 below). */
export function gutterY() {
  const width = windowSize().width;
  if (width <= 620) return 10;
  if (width <= 980) return 12;
  return Math.min(20, Math.max(12, width * 0.014));
}

// A row's fill eases in and out (Vue: background-color 180ms ease). The hover state adds a 60 ms
// delay, so the fill comes in only once the pointer rests; leaving takes the base style's timing,
// with no delay.
export const ROW_TRANSITION = { transitionProperty: "colors", transitionDuration: 180, transitionTimingFunction: "ease" } as const;
export const ROW_HOVER = { transitionDelay: 60 } as const;

/** An inline notice in the page (the Vue console's AppNotice): an error, a warning or a note. */
export function InlineNotice(props: { type?: "error" | "warning" | "info"; text: string; testID?: string; class?: string }) {
  const tone = () => props.type ?? "error";
  return (
    <View
      testID={props.testID}
      role="alert"
      class={`flex-row items-start gap-2 rounded-(--radius) border-l-2 bg-card px-3 py-2 ${
        tone() === "error" ? "border-danger" : tone() === "warning" ? "border-warn" : "border-blue"
      } ${props.class ?? ""}`}
    >
      <Icon
        name={tone() === "error" ? "PhWarningCircle" : tone() === "warning" ? "PhWarning" : "PhInfo"}
        size={16}
        color={tone() === "error" ? "danger" : tone() === "warning" ? "warn-dark" : "blue"}
      />
      <View class="flex-1" selectable>
        <Text class="text-sm text-foreground">{props.text}</Text>
      </View>
    </View>
  );
}

/** A quiet line of text: an empty list, a hint (12pt, text-2, as the pages' *-note classes). */
export function Note(props: { text: string; class?: string; testID?: string }) {
  return (
    <Text testID={props.testID} class={`text-xs leading-[17.4px] text-muted-foreground ${props.class ?? ""}`}>
      {props.text}
    </Text>
  );
}

/**
 * The search field at the top of an index or a grid. Memories uses the plain 32pt field (AppInput,
 * 12pt text); Skills and the store add the magnifier. Topics, Contacts and Settings use `IndexSearch`.
 */
export function SearchField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onSubmit?: () => void;
  /** The magnifier before the text (default true). */
  icon?: boolean;
  /** 16pt text (the store's) instead of 12pt. */
  large?: boolean;
  testID?: string;
  class?: string;
}) {
  return (
    <TextField
      value={props.value}
      onChange={(value) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      placeholder={props.placeholder}
      accessibilityLabel={props.placeholder}
      leadingIcon={props.icon === false ? undefined : "PhMagnifyingGlass"}
      size="xs"
      inputClass={props.large ? "text-base" : undefined}
      testID={props.testID}
      class={props.class}
    />
  );
}

/** The index search's box: its gutters, the room above and below the field, and the field's size. */
export function indexSearchMetrics(mobile: boolean) {
  // The list's 16pt gutter on a desktop, the page's phone gutter on a phone, where rows run edge to
  // edge with their content that far in. 6pt above the field, under the 57pt head, and 2pt below
  // it, then the list's own 8pt before its first row: 8pt of room in all, more of it above, so the
  // field stands off the head and stays close to the rows it filters.
  const gutter = mobile ? gutterX() : 16;
  return { gutter, top: 6, bottom: 2, size: (mobile ? "md" : "sm") as "md" | "sm" };
}

/**
 * The search at the top of the Topics, Contacts and Settings lists, one field for all: a 14pt text field
 * with the magnifier and a clear button, 38pt tall on a desktop and 44pt (a touch target) on a
 * phone, as wide as the column less its gutters. Escape empties it while it has the focus and holds
 * text. It owns its spacing and gutters: make it the list's first view (outside any gutter of the
 * rows), on a phone and a desktop alike, never part of the head; or `IndexColumn`'s `search`.
 */
export function IndexSearch(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** The phone layout (default: the console's mobile breakpoint). */
  mobile?: boolean;
  testID: string;
  /** The field, to focus it (a keyboard shortcut). */
  inputRef?: (node: InputRef) => void;
  /** Enter in the field (Settings opens its first result). */
  onSubmit?: (text: string) => void;
  /** Called after the clear button emptied the field. */
  onClear?: () => void;
  /** The clear button's accessible name (default "Clear"). */
  clearLabel?: string;
}) {
  const metrics = () => indexSearchMetrics(props.mobile ?? isMobile());
  const focused = signal(false);
  effect(() => {
    if (!focused() || !props.value) return;
    cleanup(keymap.bind("escape", () => props.onChange(""), { when: "always" }));
  });
  return (
    <View
      testID={`${props.testID}-box`}
      style={{
        paddingLeft: metrics().gutter,
        paddingRight: metrics().gutter,
        paddingTop: metrics().top,
        paddingBottom: metrics().bottom,
      }}
    >
      <TextField
        value={props.value}
        onChange={(value) => props.onChange(value)}
        onSubmit={(text) => props.onSubmit?.(text)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        leadingIcon="PhMagnifyingGlass"
        size={metrics().size}
        clearable
        onClear={() => props.onClear?.()}
        clearLabel={props.clearLabel}
        testID={props.testID}
        inputRef={(node) => props.inputRef?.(node)}
      />
    </View>
  );
}

/** The title of an index column or a page bar: the 20pt title face, regular, tight. */
export function WorkspaceTitle(props: { text: string; class?: string }) {
  return (
    <Text role="header" class={`text-xl font-normal leading-[24.0px] tracking-[-0.03em] text-foreground ${props.class ?? ""}`} style={{ numberOfLines: 1 }}>
      {props.text}
    </Text>
  );
}

/**
 * An icon button of an index column's head: the standard round one (CircleButton, 38pt) with a
 * regular icon button's 16pt icon (BAR_ICON_SIZE), as the Topics and TODO heads' buttons are; its
 * title is its tooltip.
 */
export function HeadButton(props: { icon: IconName; title: string; disabled?: boolean; onPress: () => void; testID?: string }) {
  return (
    <CircleButton
      icon={props.icon}
      iconSize={BAR_ICON_SIZE}
      title={props.title}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class="disabled:opacity-50"
      testID={props.testID}
    />
  );
}

/**
 * The index column of a workspace page: its head (the page title and actions, 57pt), an optional
 * search under it, then the list, which scrolls on its own and fades at an edge that hides rows.
 * Once rows have gone under the head, the head's hairline shows. On a phone it fills the page
 * (`fill`) and its rows run edge to edge.
 */
export function IndexColumn(props: {
  title: string;
  actions?: JSX.Element;
  /** Above the scrolling list (a search field), in a box padded 16pt (14 above). */
  top?: JSX.Element;
  /** Above the scrolling list as it is, with no box of its own: an `IndexSearch`. */
  search?: JSX.Element;
  fill?: boolean;
  label?: string;
  testID?: string;
  children?: JSX.Element;
  /** Draw the body yourself (a List that scrolls on its own). */
  scroll?: boolean;
  /** The head's right padding: the gutter (default) or none (a row of buttons to the edge). */
  headRight?: "gutter" | "none";
  /** Classes of the list's content (default: 16pt all round, 2pt between rows). */
  listClass?: string;
  /** Its motion as a phone's pane (components/motion/PaneStack.tsx), and whether it is going out. */
  style?: Record<string, unknown>;
  hidden?: boolean;
}) {
  const edges = createScrollEdges({ start: false });
  const hasTop = () => Boolean(props.top || props.search);
  const listPad = () => (props.fill ? (hasTop() ? "pt-2" : "pt-4") : hasTop() ? "px-4 pt-2" : "px-4 pt-4");
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.label ?? props.title}
      class={props.fill ? "flex-1" : "w-[310px] min-w-55"}
      style={props.style}
      accessibilityElementsHidden={props.hidden || undefined}
      importantForAccessibility={props.hidden ? "no-hide-descendants" : undefined}
    >
      <View
        class="h-[57px] flex-row items-center justify-between gap-3 border-b"
        style={{
          paddingLeft: gutterX(),
          paddingRight: props.headRight === "none" && !props.fill ? 0 : gutterX(),
          borderColor: edges.scrolled() ? "#a5bad040" : "#a5bad000",
          transitionProperty: "colors",
          transitionDuration: motionMs(MOTION_NORMAL),
          transitionTimingFunction: MOTION_EASE_CSS,
        }}
      >
        <View class="flex-1">
          <WorkspaceTitle text={props.title} />
        </View>
        <If when={props.actions}>
          <View class="flex-row items-center gap-0.5">{props.actions}</View>
        </If>
      </View>
      <If when={props.top}>
        <View class="px-4 pb-2 pt-3.5">{props.top}</View>
      </If>
      <If when={props.search}>{props.search}</If>
      <If when={props.scroll !== false} else={<View class="flex-1">{props.children}</View>}>
        <Scroll
          class="flex-1"
          scrollbar={SCROLLBAR}
          contentClass="grow"
          onScroll={edges.handlers.onScroll}
          onLayout={edges.handlers.onLayout}
          scrollEventThrottle={edges.handlers.scrollEventThrottle}
          style={edges.style()}
        >
          <View class={`grow gap-0.5 ${props.listClass ?? listPad()}`} style={{ paddingBottom: 16 + gutterY() }} onLayout={edges.onContentLayout}>
            {props.children}
          </View>
          <MobileBarSpacer />
        </Scroll>
      </If>
    </View>
  );
}

/** A group heading in an index: a small mono label, then a rule that runs out to the edge, fading. */
export function IndexDivider(props: { label: string; class?: string }) {
  return (
    <View class={`flex-row items-center gap-2.5 px-3.5 pb-1 pt-2.5 ${props.class ?? ""}`}>
      <Text role="header" class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[0.12em] text-muted-foreground" style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      <View class="h-px flex-1" style={{ backgroundImage: "linear-gradient(to right, #a5bad085, #a5bad000)" }} />
    </View>
  );
}

/**
 * One row of an index: a title (14pt, 15 on mobile; two lines at most) and a meta line (12pt),
 * something before (a 20pt icon, an avatar) and after (a count, a 16pt marker). `sliding`: the
 * list draws the selected fill as one gliding highlight, so the row keeps none of its own.
 */
export function IndexRow(props: {
  title: string;
  meta?: string;
  /** Lines of the meta (default 1; the skills list shows 2). */
  metaLines?: number;
  /** The meta fades when cut instead of ending in "…" (Contacts). */
  metaFade?: boolean;
  active?: boolean;
  sliding?: boolean;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  icon?: IconName;
  onPress: () => void;
  onLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const phone = () => isMobile() && windowSize().width <= 620;
  const pad = () =>
    props.meta
      ? phone()
        ? "px-3 py-[11px]"
        : "pt-3 pr-[13px] pb-[11px] pl-3.5"
      : phone()
        ? "min-h-11 px-3 py-2.5"
        : "min-h-10 py-2 pr-[13px] pl-3.5";
  // The title's line: 15.1pt over a meta and 18.2 alone at 14pt, as much more at mobile's 15pt.
  const titleLeading = () =>
    isMobile() ? (props.meta ? "leading-[16.2px]" : "leading-[19.5px]") : props.meta ? "leading-[15.1px]" : "leading-[18.2px]";
  // The selected row hovered deepens its fill to 13 %: over the gliding highlight a 3 % layer, on
  // a row that draws its own fill the stronger fill itself.
  const hover = () => (props.active ? (props.sliding ? "hover:bg-[#426f9e08]" : "hover:bg-selection-strong") : "hover:bg-hover-soft");
  return (
    <BaseButton
      testID={props.testID}
      onPress={() => props.onPress()}
      onLayout={props.onLayout}
      selected={props.active === true}
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      class={`flex-row items-center gap-2.5 rounded-(--radius) border border-transparent ${pad()} ${hover()} ${
        props.active && !props.sliding ? "bg-selection" : ""
      }`}
      style={ROW_TRANSITION}
      hoverStyle={ROW_HOVER}
    >
      <If when={props.icon}>
        <View class="size-5 items-center justify-center">
          <Icon name={props.icon!} size={15} color="muted-foreground" />
        </View>
      </If>
      {props.leading}
      <View class="flex-1 gap-1">
        <Text class={`${listTitleSize(isMobile())} tracking-[-0.025em] text-foreground ${titleLeading()}`} style={{ numberOfLines: 2 }}>
          {props.title}
        </Text>
        <If when={props.meta}>
          <If
            when={props.metaFade}
            else={
              <Text class={`text-xs leading-[16.8px] ${props.active ? "text-subtle" : "text-muted-foreground"}`} style={{ numberOfLines: props.metaLines ?? 1 }}>
                {props.meta}
              </Text>
            }
          >
            <FadeText text={props.meta!} class={`text-xs leading-[16.8px] ${props.active ? "text-subtle" : "text-muted-foreground"}`} fade={29} />
          </If>
        </If>
      </View>
      {props.trailing}
    </BaseButton>
  );
}

/** The count at the end of an index row: mono 11pt, tabular. */
export function RowCount(props: { value: number | string }) {
  return <Text class="font-mono text-[11px] tabular-nums text-muted-foreground">{String(props.value)}</Text>;
}

/** A loading placeholder of `count` blocks. */
export function Blocks(props: { count?: number; height?: number; class?: string; label?: string }) {
  const rows = () => Array.from({ length: Math.max(1, props.count ?? 3) }, (_, index) => index);
  return (
    <View class={`gap-2 ${props.class ?? ""}`} accessibilityLabel={props.label}>
      <Each of={rows()}>{() => <View class="rounded-(--radius) bg-muted" style={{ height: props.height ?? 52 }} />}</Each>
    </View>
  );
}

/**
 * A boxed section (AppSection variant="boxed"): a hairline frame on the paper whose top strip is
 * the head, 48pt with a hairline under it: the title as a mono label (a name keeps its case,
 * `literal`; a section name is caps), the meta on the same line after it, cut to one line, and the
 * actions at the far end, one control high. The body is padded 16pt (`bodyClass` replaces it: a
 * list of rows carries its own inset).
 */
export function DetailCard(props: {
  title: string;
  meta?: JSX.Element | string;
  actions?: JSX.Element;
  children?: JSX.Element;
  /** The title is a name the user gave: its own case (default true). */
  literal?: boolean;
  bodyClass?: string;
  testID?: string;
  class?: string;
}) {
  const literal = () => props.literal !== false;
  return (
    <View testID={props.testID} class={`rounded-(--radius) border border-line-soft bg-paper-soft ${props.class ?? ""}`}>
      <View class="h-12 flex-row items-center gap-2.5 border-b border-line-soft px-4">
        <View selectable class="shrink" style={{ minWidth: 0 }}>
          <FadeText
            role="header"
            text={props.title}
            fade={26}
            class={`font-mono text-[11px] font-semibold leading-[15.4px] text-subtle ${literal() ? "tracking-[0.02em]" : "uppercase tracking-[0.1em]"}`}
          />
        </View>
        <View class="flex-1" style={{ minWidth: 0 }}>
          <If when={typeof props.meta === "string"} else={props.meta as JSX.Element}>
            <FadeText text={props.meta as string} fade={29} class="text-xs leading-[17.4px] text-muted-foreground" />
          </If>
        </View>
        <If when={props.actions}>
          <View class="-mr-1.5 h-8 flex-row items-center gap-1">{props.actions}</View>
        </If>
      </View>
      <View class={props.bodyClass ?? "gap-4 p-4"}>{props.children}</View>
    </View>
  );
}

/** A "⋯" button of a section head's action area: 32pt square, 16pt icon. */
export function MoreTrigger(props: { label: string; testID?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      class="size-8 items-center justify-center rounded-(--radius) hover:bg-hover active:bg-press"
      style={ROW_TRANSITION}
    >
      <Icon name="PhDotsThree" size={16} color="subtle" />
    </View>
  );
}

/** Label-and-value rows between hairlines (ui-property-list). */
export function PropertyList(props: { children?: JSX.Element; testID?: string }) {
  return (
    <View testID={props.testID} class="border-t border-line-soft/80">
      {props.children}
    </View>
  );
}

/** A label and its value: 12pt caps label in a 112pt column (88 on phones), 12pt value. */
export function PropertyRow(props: { label: string; children?: JSX.Element; center?: boolean; testID?: string }) {
  return (
    <View
      testID={props.testID}
      class={`flex-row border-b border-line-soft/80 py-[11px] ${props.center ? "items-center" : "items-start"} ${isMobile() ? "gap-3" : "gap-4"}`}
    >
      <Text
        class={`text-xs uppercase leading-[15.6px] tracking-[0.04em] text-muted-foreground ${isMobile() ? "w-22" : "w-28"} ${props.center ? "" : "pt-[1.2px]"}`}
      >
        {props.label}
      </Text>
      <View class="flex-1 gap-2" style={{ minWidth: 0 }}>
        {props.children}
      </View>
    </View>
  );
}

/** A value of a property row, as text that can be selected; `mono` (a path, an id) stays on one
 * line and fades where it is cut, with the whole text as its tooltip. */
export function PropertyText(props: { text: string; mono?: boolean; class?: string }) {
  return (
    <View selectable>
      <If when={props.mono} else={<Text class={`text-xs leading-normal text-subtle ${props.class ?? ""}`}>{props.text}</Text>}>
        <FadeText text={props.text} fade={29} class={`font-mono text-xs leading-normal text-foreground ${props.class ?? ""}`} />
      </If>
    </View>
  );
}

/** A link inside a property: blue, underlined on hover; opens outside the app. */
export function LinkText(props: { text: string; onPress: () => void; testID?: string }) {
  return (
    <Text testID={props.testID} role="link" onPress={() => props.onPress()} class="text-xs leading-normal text-blue hover:underline">
      {props.text}
    </Text>
  );
}

/**
 * The phone's page bar while one item is open: back (the shared BackButton, as big as Todo's
 * calendar toggle), then its title (the workspace title face). Android's Back does what its back
 * arrow does while it shows.
 */
export function MobileBar(props: {
  title: string;
  backLabel: string;
  onBack?: () => void;
  actions?: JSX.Element;
  /** Hears where the back arrow lies on the page as `back` (tests). */
  onPartLayout?: PartLayoutListener;
}) {
  onSystemBack(
    () => Boolean(props.onBack),
    () => props.onBack?.(),
  );
  return (
    <View class="h-[57px] flex-row items-center gap-2 border-b border-line-soft" style={{ paddingLeft: gutterX(), paddingRight: gutterX() }}>
      <If when={props.onBack}>
        <BackButton title={props.backLabel} onPress={() => props.onBack?.()} testID="mobile-back" onPartLayout={props.onPartLayout} />
      </If>
      <View class="flex-1">
        <WorkspaceTitle text={props.title} />
      </View>
      {props.actions}
    </View>
  );
}

/** A section title inside a card (Contacts: Connections, Memories, Activity): 14pt semibold. */
export function SubHeading(props: { text: string; right?: JSX.Element }) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <Text role="header" class="text-sm font-semibold leading-[18.9px] text-foreground">
        {props.text}
      </Text>
      {props.right}
    </View>
  );
}

/** A small mono caps label (SKILL.md's head, the store's doc label). */
export function MonoLabel(props: { text: string; class?: string }) {
  return (
    <Text class={`font-mono text-[11px] font-medium uppercase leading-none tracking-[0.12em] text-muted-foreground ${props.class ?? ""}`}>
      {props.text}
    </Text>
  );
}

/**
 * A switch with no visible label; `label` is what screen readers say (AppSwitch with aria-label).
 * The same look as ui.tsx's Toggle: a 34x20 square track, ink when on, and a 14pt thumb that
 * springs across.
 */
export function SwitchOnly(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.label}
      testID={props.testID}
      hitSlop={6}
      class="group flex-row items-center disabled:opacity-50"
      trackClass="h-5 w-[34px] rounded-(--radius) border border-line p-[2px] transition duration-180 group-hover:border-muted-foreground checked:border-ink checked:bg-ink"
      thumbClass="size-3.5 rounded-[1px] bg-card checked:translate-x-3.5"
      thumbStyle={{
        boxShadow: props.checked ? "0 0 0 1px rgba(33, 68, 107, 0.6)" : "0 0 0 1px rgba(24, 24, 50, 0.22), 0 1px 1px rgba(24, 24, 50, 0.1)",
        transitionProperty: "transform",
        transitionDuration: motionMs(260),
        transitionTimingFunction: "cubic-bezier(0.3, 1.35, 0.5, 1)",
      }}
    />
  );
}

/** A caret that turns (0 → `turn` degrees) as its section opens, instead of swapping icons. */
export function TurnCaret(props: { open: boolean; turn?: number; size?: number; duration?: number; icon?: IconName; class?: string }) {
  return (
    <View
      accessibilityElementsHidden
      class={props.class}
      style={{
        rotate: props.open ? `${props.turn ?? 180}deg` : "0deg",
        transitionProperty: "transform",
        transitionDuration: motionMs(props.duration ?? 160),
        transitionTimingFunction: props.duration ? MOTION_EASE_CSS : "ease",
      }}
    >
      <Icon name={props.icon ?? "PhCaretDown"} size={props.size ?? 12} color="muted-foreground" />
    </View>
  );
}

