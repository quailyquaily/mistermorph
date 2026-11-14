// The Contacts head's tabs between the agent's human contacts and its agent contacts: icons only,
// as the Topics head's view toggles (ViewToggle, pages/chat/TopicSidebar.tsx) look, a person and a
// robot in round 38pt buttons with the head's 16pt icons (BAR_ICON_SIZE), flush; the current one a
// blue icon on a blue tint. Their names ("Humans", "Agents") are their accessible names and
// tooltips, never drawn.
//
// They are nsh/base's `Tabs` and `Tab`, so assistive tech hears a tab list whose current tab is
// selected, and the keyboard works as WAI-ARIA's tab list pattern says: the list is one Tab stop (at
// the current tab), Left/Right (and Up/Down, Home/End) move to the other tab and select it, Space
// and Return press the focused one; a keyboard focus draws a blue ring round the circle. On a phone
// each tab takes a 44pt square of presses around its 38pt circle (a touch target), the circles
// staying the size the Topics head's are.
import { View, type ViewRef } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { t } from "../../components/knowledge/parts";
import { BAR_ICON_SIZE, Icon, Tip, type IconName } from "../../components/ui";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "../../components/shared/partProbe";
import type { ContactKind } from "./contact-format";

/** The tabs in order: humans first (the page opens on them), then agents. */
export const CONTACT_KIND_TABS: { kind: ContactKind; icon: IconName; label: () => string }[] = [
  { kind: "human", icon: "PhUserCircle", label: () => t("contacts_tab_humans") },
  { kind: "agent", icon: "PhRobot", label: () => t("contacts_tab_agents") },
];

/** A tab's circle (the Topics head's buttons'). */
export const CONTACT_KIND_TAB_CIRCLE = 38;
/** A tab's press target on a phone; on a desktop it is the circle. */
export const CONTACT_KIND_TAB_TOUCH = 44;

/** A tab's circle: round, its icon in the middle, the Topics toggles' hover, press and selected fills, and a ring while the keyboard is on it. */
export const CONTACT_KIND_TAB_CIRCLE_CLASS =
  "size-[38px] items-center justify-center rounded-full border-2 border-transparent transition-colors duration-[180ms] group-hover:bg-hover group-active:bg-press group-selected:bg-blue/12 group-focus-visible:border-blue";

export function ContactKindTabs(props: {
  value: ContactKind;
  onChange: (kind: ContactKind) => void;
  /** A phone: 44pt press targets. */
  mobile: boolean;
  /** Hears where parts lie on the page (tests): `tab-<kind>` (its press target), `tab-<kind>-circle` and `tab-<kind>-icon`. */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  return (
    <Tabs class="flex-row items-center" testID="contacts-kind-tabs">
      <Each of={CONTACT_KIND_TABS} key={(tab) => tab.kind}>
        {(tab) => {
          const selected = () => props.value === tab().kind;
          let node: ViewRef | undefined;
          let circle: PartFrame | undefined;
          let icon: PartFrame | undefined;
          const report = () => {
            const kind = tab().kind;
            parts.report(`tab-${kind}`, node);
            parts.report(`tab-${kind}-circle`, node, () => circle);
            parts.report(`tab-${kind}-icon`, node, () => (circle && icon ? { ...icon, x: circle.x + icon.x, y: circle.y + icon.y } : undefined));
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
                    circle = boundsFrame(event);
                    report();
                  }}
                >
                  <Icon
                    name={tab().icon}
                    size={BAR_ICON_SIZE}
                    color={selected() ? "blue" : "subtle"}
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
