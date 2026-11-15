// The Contacts head's tabs between the agent's human contacts and its agent contacts: icons only, a
// person and a robot, drawn as the app's tabs are (`Tabs`, components/ui.tsx; design/ui-refresh.html
// §1): quiet 16pt icons (BAR_ICON_SIZE) on a hairline, the current one in ink with the hairline
// dipping softly under it (SagRule), the dip gliding to the other tab when it changes. No fill, no
// circle. Their names ("Humans", "Agents") are their accessible names and tooltips, never drawn.
//
// They are nsh/base's `Tabs` and `Tab` (ui.tsx's `Tabs` has no roving focus), so assistive tech hears
// a tab list whose current tab is selected, and the keyboard works as WAI-ARIA's tab list pattern
// says: the list is one Tab stop (at the current tab), Left/Right (and Up/Down, Home/End) move to
// the other tab and select it, Space and Return press the focused one; a keyboard focus draws a blue
// ring round the tab's 36pt box (the size of an icon option of `Tabs`). A tab is 38pt wide and tall
// on a desktop (the head's controls' size) and takes a 44pt square of presses on a phone (a touch
// target); the hairline lies where a 38pt tab's would on both, so the phone's larger targets move
// nothing that is drawn but the tabs' spacing.
import { token, View, type ViewRef } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { t } from "../../components/knowledge/parts";
import { sagHalf, SagRule } from "../../components/motion/Sag";
import { BAR_ICON_SIZE, Icon, Tip, type IconName } from "../../components/ui";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "../../components/shared/partProbe";
import type { ContactKind } from "./contact-format";

/** The tabs in order: humans first (the page opens on them), then agents. */
export const CONTACT_KIND_TABS: { kind: ContactKind; icon: IconName; label: () => string }[] = [
  { kind: "human", icon: "PhUserCircle", label: () => t("contacts_tab_humans") },
  { kind: "agent", icon: "PhRobot", label: () => t("contacts_tab_agents") },
];

/** A tab on a desktop: the head's controls' size. */
export const CONTACT_KIND_TAB_SIZE = 38;
/** A tab's press target on a phone. */
export const CONTACT_KIND_TAB_TOUCH = 44;
/** The box the icon sits in, which the keyboard's focus ring is drawn round (an icon option of `Tabs`). */
export const CONTACT_KIND_TAB_BOX = 36;

/** A tab's box: its icon in the middle, nothing drawn but a ring while the keyboard is on the tab. */
export const CONTACT_KIND_TAB_BOX_CLASS =
  "size-9 items-center justify-center rounded-md border-2 border-transparent transition-colors duration-[180ms] group-focus-visible:border-blue";

/** The icons' colours, as `Tabs` draws its options: the current tab in ink, the other quiet. */
export const CONTACT_KIND_TAB_ICON = { selected: "ink", idle: "muted-foreground" } as const;

/** A tab's side: the press target on a phone. */
export const contactKindTabSize = (mobile: boolean) => (mobile ? CONTACT_KIND_TAB_TOUCH : CONTACT_KIND_TAB_SIZE);

/** How far the hairline runs past the tabs at each end, so a dip under an end tab rejoins the line on both sides. */
export const CONTACT_KIND_RULE_OVERHANG = 8;

/** Where the hairline dips: the x of the current tab's centre in the hairline (the tabs are flush, each `contactKindTabSize` wide). */
export function contactKindDipCenter(kind: ContactKind, mobile: boolean) {
  const size = contactKindTabSize(mobile);
  return CONTACT_KIND_RULE_OVERHANG + Math.max(0, CONTACT_KIND_TABS.findIndex((tab) => tab.kind === kind)) * size + size / 2;
}

export function ContactKindTabs(props: {
  value: ContactKind;
  onChange: (kind: ContactKind) => void;
  /** A phone: 44pt press targets. */
  mobile: boolean;
  /** Hears where parts lie on the page (tests): `tab-<kind>` (its press target), `tab-<kind>-box`, `tab-<kind>-icon` and `rule` (the hairline's canvas). */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  return (
    <Tabs class="relative flex-row items-center" testID="contacts-kind-tabs">
      <Each of={CONTACT_KIND_TABS} key={(tab) => tab.kind}>
        {(tab) => {
          const selected = () => props.value === tab().kind;
          let node: ViewRef | undefined;
          let box: PartFrame | undefined;
          let icon: PartFrame | undefined;
          const report = () => {
            const kind = tab().kind;
            parts.report(`tab-${kind}`, node);
            parts.report(`tab-${kind}-box`, node, () => box);
            parts.report(`tab-${kind}-icon`, node, () => (box && icon ? { ...icon, x: box.x + icon.x, y: box.y + icon.y } : undefined));
          };
          return (
            // The tooltip's view (nsh/base's pressables drop a `tooltip` of their own), which also
            // says the tab's state to tests.
            <View
              ref={(value: ViewRef) => {
                node = value;
              }}
              onLayout={() => report()}
              tooltip={<Tip text={tab().label()} />}
              testID={`contacts-tab-${tab().kind}-${selected() ? "selected" : "idle"}`}
            >
              <Tab
                selected={selected()}
                accessibilityLabel={tab().label()}
                onPress={() => {
                  if (!selected()) props.onChange(tab().kind);
                }}
                testID={`contacts-tab-${tab().kind}`}
                class={`group items-center justify-center ${props.mobile ? "size-11" : "size-[38px]"}`}
              >
                <View
                  class={CONTACT_KIND_TAB_BOX_CLASS}
                  onLayout={(event) => {
                    box = boundsFrame(event);
                    report();
                  }}
                >
                  <Icon
                    name={tab().icon}
                    size={BAR_ICON_SIZE}
                    color={selected() ? CONTACT_KIND_TAB_ICON.selected : CONTACT_KIND_TAB_ICON.idle}
                    onLayout={(event) => {
                      icon = boundsFrame(event);
                      report();
                    }}
                  />
                </View>
              </Tab>
            </View>
          );
        }}
      </Each>
      {/* The hairline, 1pt above the foot of a 38pt tab (as under `Tabs`): a phone's 44pt targets reach
          3pt past it. It runs 8pt past the tabs at each end (CONTACT_KIND_RULE_OVERHANG), inside the head's gutter. */}
      <View
        class={`absolute -left-2 -right-2 h-[7px] ${props.mobile ? "-bottom-[3px]" : "-bottom-[6px]"}`}
        style={{ pointerEvents: "none" }}
        {...parts.probe(() => "rule")}
      >
        <SagRule
          center={() => contactKindDipCenter(props.value, props.mobile)}
          half={sagHalf(CONTACT_KIND_TAB_SIZE)}
          color={String(token("line-soft"))}
          class="h-[7px]"
        />
      </View>
    </Tabs>
  );
}
