// The Contacts head's tabs between the agent's human contacts and its agent contacts: the shared
// head tabs (components/shared/HeadTabs.tsx), a person and a robot. Nothing is drawn in the head's
// middle: the head's own bottom hairline dips under the current tab (IndexColumn's `sag`, placed
// with `contactKindSagCenter`), the dip gliding to the other tab when it changes. Their names
// ("Humans", "Agents") are their accessible names and tooltips, never drawn.
import { t } from "../../components/knowledge/parts";
import {
  HEAD_TAB_CIRCLE_CLASS,
  HEAD_TAB_ICON,
  HEAD_TAB_SIZE,
  HEAD_TAB_TOUCH,
  HeadTabs,
  headTabSize,
  headTabsPull,
  headTabsSagCenter,
} from "../../components/shared/HeadTabs";
import type { IconName } from "../../components/ui";
import type { PartLayoutListener } from "../../components/shared/partProbe";
import type { ContactKind } from "./contact-format";

/** The tabs in order: humans first (the page opens on them), then agents. */
export const CONTACT_KIND_TABS: { kind: ContactKind; icon: IconName; label: () => string }[] = [
  { kind: "human", icon: "PhUserCircle", label: () => t("contacts_tab_humans") },
  { kind: "agent", icon: "PhRobot", label: () => t("contacts_tab_agents") },
];

// The shared head tabs' measures, under the names this head's tests and callers know them by.
export const CONTACT_KIND_TAB_SIZE = HEAD_TAB_SIZE;
export const CONTACT_KIND_TAB_TOUCH = HEAD_TAB_TOUCH;
export const CONTACT_KIND_TAB_CIRCLE_CLASS = HEAD_TAB_CIRCLE_CLASS;
export const CONTACT_KIND_TAB_ICON = HEAD_TAB_ICON;
export const contactKindTabSize = headTabSize;
export const contactKindStripPull = headTabsPull;

/** Where the head's hairline dips: the x of the current tab's centre in the strip. */
export function contactKindSagCenter(kind: ContactKind, mobile: boolean) {
  return headTabsSagCenter(Math.max(0, CONTACT_KIND_TABS.findIndex((tab) => tab.kind === kind)), mobile) as number;
}

export function ContactKindTabs(props: {
  value: ContactKind;
  onChange: (kind: ContactKind) => void;
  /** A phone: 44pt press targets. */
  mobile: boolean;
  /** Hears where parts lie on the page (tests): `tab-<kind>` (its press target), `tab-<kind>-box` (its circle) and `tab-<kind>-icon`. */
  onPartLayout?: PartLayoutListener;
}) {
  return (
    <HeadTabs
      tabs={CONTACT_KIND_TABS.map((tab) => ({ id: tab.kind, icon: tab.icon, label: tab.label() }))}
      value={props.value}
      onChange={props.onChange}
      mobile={props.mobile}
      testID="contacts-kind-tabs"
      name="contacts-tab"
      onPartLayout={props.onPartLayout}
    />
  );
}
