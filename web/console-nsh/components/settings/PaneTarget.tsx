// Where a settings panel's side pane goes (the Vue panels' `paneTarget`, a Teleport target).
//
// A page with a pane column makes one target and puts its outlet last in the row that holds the
// list and the pane:
//
//   const pane = createPaneTarget();
//   <View class="flex-1 flex-row">
//     <Scroll class="flex-1">... <MCPSettingsPanel paneTarget={pane} ... /> ...</Scroll>
//     <PaneOutlet target={pane} />
//   </View>
//
// A panel given a target (and not `mobile`) shows its pane there; without one it shows the pane
// beside its own list, and on phones (`mobile`) as a drawer.
import type { JSX } from "nsh";
import { cleanup, effect, type Signal, signal, Scroll, Text, untracked, View } from "nsh";
import { Button, SidePane } from "../ui";

/** What a panel puts in the outlet: an id (a new id rebuilds the pane) and how to draw it. */
export interface PaneContent {
  key: string;
  render: () => JSX.Element;
}

export interface PaneTarget {
  content: Signal<PaneContent | null>;
}

export function createPaneTarget(): PaneTarget {
  return { content: signal<PaneContent | null>(null) };
}

/** The page's pane column: shows what a panel put in `target`, nothing otherwise. */
export function PaneOutlet(props: { target: PaneTarget }) {
  const items = () => {
    const content = props.target.content();
    return content ? [content] : [];
  };
  return (
    <Each of={items()} key={(item) => item.key}>
      {(item) => untracked(() => item().render())}
    </Each>
  );
}

/**
 * Puts a panel's pane in `target` while `active()` is true, and takes it out when it closes or the
 * panel goes. `key()` names the pane: a new key rebuilds it (the Vue pane's `paneKey`).
 */
export function usePaneTarget(
  target: () => PaneTarget | undefined,
  active: () => boolean,
  key: () => string,
  render: () => JSX.Element,
) {
  let placed: { target: PaneTarget; content: PaneContent } | null = null;
  const remove = () => {
    if (placed && untracked(() => placed!.target.content()) === placed.content) {
      placed.target.content.set(null);
    }
    placed = null;
  };
  effect(() => {
    const to = target();
    const on = active();
    const id = key();
    untracked(() => {
      if (!to || !on) {
        remove();
        return;
      }
      if (placed && placed.target === to && placed.content.key === id) return;
      remove();
      const content = { key: id, render };
      to.content.set(content);
      placed = { target: to, content };
    });
  });
  cleanup(remove);
}

/**
 * A settings pane (the Vue AppSidePane with an AppSection inside): a header with the title, its
 * meta and a close button, a scrolling body, and a footer when `foot` is given.
 */
export function SettingsPane(props: {
  open: boolean;
  /** A drawer from the right (phones). */
  sheet?: boolean;
  title: string;
  meta?: string;
  label?: string;
  closeLabel: string;
  onClose: () => void;
  children?: JSX.Element;
  foot?: JSX.Element;
  testID?: string;
}) {
  return (
    <SidePane open={props.open} sheet={props.sheet} onClose={props.onClose} label={props.label || props.title}>
      <View class="flex-1" testID={props.testID}>
        <View class="flex-row items-start gap-3 border-b border-line-faint px-4 py-3">
          <View class="flex-1 gap-0.5">
            <Text class="text-base font-semibold text-foreground line-clamp-1" role="header">
              {props.title}
            </Text>
            <If when={props.meta}>
              <Text class="text-xs text-muted-foreground">{props.meta}</Text>
            </If>
          </View>
          <Button variant="plain" size="xs" iconOnly icon="PhX" title={props.closeLabel} onPress={props.onClose} />
        </View>
        <Scroll class="flex-1" contentClass="gap-4 p-4">
          {props.children}
        </Scroll>
        <If when={props.foot}>
          <View class="flex-row items-center justify-end gap-3 border-t border-line-faint px-4 py-3">{props.foot}</View>
        </If>
      </View>
    </SidePane>
  );
}
