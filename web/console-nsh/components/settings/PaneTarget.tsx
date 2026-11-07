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
import { cleanup, effect, type Signal, signal, Scroll, untracked, View } from "nsh";
import { Button, SidePane } from "../ui";
import { SCROLLBAR } from "../motion";
import { PaneHead } from "../settings-page/parts";
import { InSidePane } from "./SettingFields";

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
  /** Plain icon buttons before the close button. */
  actions?: JSX.Element;
  /** The title is a name the user gave: keep its case. */
  literal?: boolean;
  testID?: string;
}) {
  return (
    <SidePane open={props.open} sheet={props.sheet} onClose={props.onClose} label={props.label || props.title}>
      <InSidePane.Provider value={true}>
      <View class="flex-1" testID={props.testID}>
        <PaneHead
          title={props.title}
          meta={props.meta}
          literal={props.literal}
          actions={
            <>
              {props.actions}
              <Button variant="plain" size="xs" iconOnly icon="PhX" title={props.closeLabel} onPress={props.onClose} />
            </>
          }
        />
        <Scroll class="flex-1" contentClass="gap-4 px-4 pb-6 pt-4" scrollbar={SCROLLBAR}>
          {props.children}
        </Scroll>
        <If when={props.foot}>
          <View class="flex-row items-center justify-end gap-3 border-t border-line-soft px-4 pb-4 pt-3">{props.foot}</View>
        </If>
      </View>
      </InSidePane.Provider>
    </SidePane>
  );
}
