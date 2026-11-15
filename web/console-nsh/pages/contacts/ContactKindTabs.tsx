// The Contacts head's tabs between the agent's human contacts and its agent contacts: icons only, a
// person and a robot, drawn as the Topics head draws its view toggles (`ViewToggle`,
// pages/chat/TopicSidebar.tsx): the standard round 38pt button (`circleButtonClass`) with a 16pt
// icon (BAR_ICON_SIZE), the circles flush on a desktop; the current tab a blue icon on a blue tint
// (`bg-blue/12`), the other a quiet icon with the plain button's hover and press fills. As in
// Topics, nothing is drawn in the head's middle: the head's own bottom hairline dips under the
// current tab (IndexColumn's `sag`, placed with `contactKindSagCenter`), the dip gliding to the
// other tab when it changes. Their names ("Humans", "Agents") are their accessible names and
// tooltips, never drawn.
//
// They are nsh/base's `Tabs` and `Tab` (ui.tsx's `Tabs` has no roving focus), so assistive tech hears
// a tab list whose current tab is selected, and the keyboard works as WAI-ARIA's tab list pattern
// says: the list is one Tab stop (at the current tab), Left/Right (and Up/Down, Home/End) move to
// the other tab and select it, Space and Return press the focused one; a keyboard focus draws a blue
// ring round the tab's circle. A tab is its 38pt circle on a desktop; on a phone it takes a 44pt
// square of presses (a touch target) with the same 38pt circle in its middle, so there the circles
// are 6pt apart, and the strip is pulled 3pt into the head's gutter so the last circle still ends
// where the Topics head's last button does.
import { View, type ViewRef } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { t } from "../../components/knowledge/parts";
import { BAR_ICON_SIZE, CIRCLE_BUTTON_ON_FILL, circleButtonClass, Icon, Tip, type IconName } from "../../components/ui";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "../../components/shared/partProbe";
import type { ContactKind } from "./contact-format";

/** The tabs in order: humans first (the page opens on them), then agents. */
export const CONTACT_KIND_TABS: { kind: ContactKind; icon: IconName; label: () => string }[] = [
  { kind: "human", icon: "PhUserCircle", label: () => t("contacts_tab_humans") },
  { kind: "agent", icon: "PhRobot", label: () => t("contacts_tab_agents") },
];

/** A tab's circle, on a desktop and a phone: the head's round buttons' size (the Topics head's toggles'). */
export const CONTACT_KIND_TAB_SIZE = 38;
/** A tab's press target on a phone. */
export const CONTACT_KIND_TAB_TOUCH = 44;

/**
 * A tab's circle: the standard round button (`circleButtonClass`, 38pt, the plain button's hover
 * and press fills) with its icon in the middle, the blue tint while its tab is selected, and a ring
 * while the keyboard is on the tab. The fills follow the tab around it (`group-*`), which on a phone
 * is larger than the circle.
 */
export const CONTACT_KIND_TAB_CIRCLE_CLASS = `${circleButtonClass()
  .split(/\s+/)
  .map((cls) => (/^(hover|active):/.test(cls) ? `group-${cls}` : cls))
  .join(" ")} border-2 border-transparent group-selected:${CIRCLE_BUTTON_ON_FILL} group-focus-visible:border-blue`;

/** The icons' colours, as the Topics head's toggles': the current tab blue, the other quiet. */
export const CONTACT_KIND_TAB_ICON = { selected: "blue", idle: "subtle" } as const;

/** A tab's side: its circle, or the press target on a phone. */
export const contactKindTabSize = (mobile: boolean) => (mobile ? CONTACT_KIND_TAB_TOUCH : CONTACT_KIND_TAB_SIZE);

/** How far a phone's strip reaches into the head's gutter, so its last circle ends at the gutter. */
export const contactKindStripPull = (mobile: boolean) => (mobile ? (CONTACT_KIND_TAB_TOUCH - CONTACT_KIND_TAB_SIZE) / 2 : 0);

/** Where the head's hairline dips: the x of the current tab's centre in the strip (the tabs are flush, each `contactKindTabSize` wide). */
export function contactKindSagCenter(kind: ContactKind, mobile: boolean) {
  const size = contactKindTabSize(mobile);
  return Math.max(0, CONTACT_KIND_TABS.findIndex((tab) => tab.kind === kind)) * size + size / 2;
}

export function ContactKindTabs(props: {
  value: ContactKind;
  onChange: (kind: ContactKind) => void;
  /** A phone: 44pt press targets. */
  mobile: boolean;
  /** Hears where parts lie on the page (tests): `tab-<kind>` (its press target), `tab-<kind>-box` (its circle) and `tab-<kind>-icon`. */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  return (
    <Tabs class="flex-row items-center" style={{ marginRight: -contactKindStripPull(props.mobile) }} testID="contacts-kind-tabs">
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
                  class={CONTACT_KIND_TAB_CIRCLE_CLASS}
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
    </Tabs>
  );
}
