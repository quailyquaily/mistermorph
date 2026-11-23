// Gallery demos: the navigation's and the frame's parts (components/frame) and the Contacts page's
// cards (pages/contacts), with stand-in agents, pages and people. Choosing an agent or a page here
// only notes the action: nothing navigates and no agent is selected.
import { signal, Text, token, View } from "nsh";
import { AgentSwitcher } from "../../../components/frame/AgentSwitcher";
import defaultEndpointAvatar from "../../../assets/images/app_logo_current.svg";
import type { EndpointItem } from "../../../lib/shell";
import { KindAvatar } from "../../contacts/ContactCard";
import { CAPSULE_COMPACT_SIZE, CapsuleButton, capsuleButtonLook, CapsuleNav, CapsuleToolbar, capsuleToolbarSize } from "../../../components/shared/CapsuleBar";
import { type HeadTab, HeadTabs, HeadTabsRule, headTabsSagCenter } from "../../../components/shared/HeadTabs";
import { act, Col, type DemoMap, LONG_TEXT, Row, t, useFlag, V } from "../demo";

type HeadView = "list" | "calendar" | "flow";
const HEAD_VIEWS: HeadTab<HeadView>[] = [
  { id: "list", icon: "PhListBullets", label: "List" },
  { id: "calendar", icon: "PhCalendarBlank", label: "Calendar" },
  { id: "flow", icon: "PhGitFork", label: "Flow" },
];

const AGENTS: EndpointItem[] = [
  { id: "ep_alpha", value: "ep_alpha", title: "Morph", image: defaultEndpointAvatar, connected: true },
  { id: "ep_beta", value: "ep_beta", title: "Atlas", image: defaultEndpointAvatar, connected: true },
  { id: "ep_long", value: "ep_long", title: LONG_TEXT, image: defaultEndpointAvatar, connected: true },
  { id: "ep_off", value: "ep_off", title: "Sleepy", image: defaultEndpointAvatar, connected: false },
];

function SwitcherDemo() {
  const selected = signal("ep_alpha");
  const current = () => AGENTS.find((item) => item.value === selected()) ?? null;
  const choose = (value: string) => {
    selected.set(value);
    act("AgentSwitcher", value);
  };
  return (
    <Row>
      <V s="default" class="w-56">
        <View class="relative rounded-(--radius) border border-line-faint bg-nav">
          <AgentSwitcher items={AGENTS} selectedItem={current()} selectedName={current()?.title} onChange={(item) => choose(item.value)} onOverview={() => act("AgentSwitcher", "overview")} />
        </View>
        <Text class="text-xs text-muted-foreground" testID="uig-agent-echo">{t("uig_fixture_echo", { value: selected() })}</Text>
      </V>
      <V l="compact" class="w-16">
        <View class="relative rounded-(--radius) border border-line-faint bg-nav">
          <AgentSwitcher compact items={AGENTS} selectedItem={current()} onChange={(item) => choose(item.value)} onOverview={() => act("AgentSwitcher", "overview")} />
        </View>
      </V>
      <V s="empty" class="w-56">
        <View class="relative rounded-(--radius) border border-line-faint bg-nav">
          <AgentSwitcher items={[]} selectedItem={null} placeholder={t("endpoint_placeholder")} />
        </View>
      </V>
    </Row>
  );
}

const PEOPLE = [
  { contact_id: "tg:1001", kind: "human", status: "active", nickname: "Ada Lovelace", channel: "telegram", tg_username: "ada" },
  { contact_id: "slack:T1:U2", kind: "human", status: "inactive", nickname: LONG_TEXT, channel: "slack" },
  { contact_id: "agent:atlas", kind: "agent", status: "active", nickname: "Atlas", channel: "console" },
  { contact_id: "line:U3", kind: "human", status: "active", nickname: "夏目漱石", channel: "line" },
  { contact_id: "tg:1002", kind: "human", status: "active", channel: "telegram" },
];

export const FRAME_DEMOS: DemoMap = {
  AgentSwitcher: { render: () => <SwitcherDemo /> },
  KindAvatar: {
    render: () => (
      <Row>
        <V l="human · 64 / 44" row><KindAvatar item={PEOPLE[0]} size={64} /><KindAvatar item={PEOPLE[0]} size={44} /></V>
        <V l="agent" row><KindAvatar item={PEOPLE[2]} size={64} /></V>
        <V s="empty" l="unnamed" row><KindAvatar item={PEOPLE[4]} size={64} /></V>
      </Row>
    ),
  },
  CapsuleNav: {
    render: () => {
      const page = signal("chat");
      const slots = [
        { id: "chat", label: "Topics", icon: "PhChats" as const, testID: "uig-capsulenav-chat" },
        { id: "contacts", label: "Contacts", icon: "PhUsers" as const, testID: "uig-capsulenav-contacts" },
        { id: "todo", label: "Jobs", icon: "PhListChecks" as const, testID: "uig-capsulenav-todo" },
        { id: "more", label: "More", icon: "PhSquaresFour" as const, testID: "uig-capsulenav-more" },
      ];
      const pick = (id: string) => {
        page.set(id);
        act("CapsuleNav", id);
      };
      return (
        <Row>
          <V s="default"><CapsuleNav slots={slots} active={page()} onPress={pick} width={390} testID="uig-capsulenav" /></V>
          <V l="narrow"><CapsuleNav slots={slots} active={page()} onPress={pick} width={200} testID="uig-capsulenav-narrow" /></V>
        </Row>
      );
    },
    wide: true,
  },
  CapsuleToolbar: {
    render: () => {
      const running = useFlag(false);
      const buttons = (compact: boolean, prefix: string) => (
        <>
          <CapsuleButton
            look={capsuleButtonLook(running.on() ? "danger" : "primary", running.on() ? "PhStop" : "PhPlay")}
            label={running.on() ? "Stop" : "Start"}
            size={capsuleToolbarSize(compact)}
            testID={`${prefix}-toggle`}
            onPress={() => {
              running.toggle();
              act("CapsuleToolbar", running.on() ? "start" : "stop");
            }}
          />
          <CapsuleButton look={capsuleButtonLook("quiet", "PhChat")} label="Open topic" size={capsuleToolbarSize(compact)} testID={`${prefix}-topic`} onPress={() => act("CapsuleToolbar", "topic")} />
        </>
      );
      return (
        <Row>
          <V l="floating"><CapsuleToolbar floating label="Sample toolbar" testID="uig-capsuletoolbar">{buttons(false, "uig-capsuletoolbar")}</CapsuleToolbar></V>
          <V l="floating · compact"><CapsuleToolbar floating compact label="Sample toolbar" testID="uig-capsuletoolbar-fc">{buttons(true, "uig-capsuletoolbar-fc")}</CapsuleToolbar></V>
          <V l="set in · compact"><CapsuleToolbar compact label="Sample toolbar" testID="uig-capsuletoolbar-c">{buttons(true, "uig-capsuletoolbar-c")}</CapsuleToolbar></V>
        </Row>
      );
    },
    wide: true,
  },
  CapsuleButton: {
    render: () => (
      <Col>
        <Each of={["primary", "danger", "quiet"] as const}>
          {(variant) => {
            const glyph = variant() === "primary" ? "PhPlay" : variant() === "danger" ? "PhStop" : "PhChat";
            return (
              <V l={variant()} row>
                <CapsuleButton look={capsuleButtonLook(variant(), glyph)} label={variant()} testID={`uig-capsulebutton-${variant()}`} onPress={() => act("CapsuleButton", variant())} />
                <CapsuleButton look={capsuleButtonLook(variant(), glyph, { busy: true })} label={`${variant()} busy`} busy testID={`uig-capsulebutton-${variant()}-busy`} />
                <CapsuleButton look={capsuleButtonLook(variant(), glyph, { disabled: true })} label={`${variant()} disabled`} disabled testID={`uig-capsulebutton-${variant()}-disabled`} />
                <CapsuleButton look={capsuleButtonLook(variant(), glyph)} label={`${variant()} compact`} size={CAPSULE_COMPACT_SIZE} testID={`uig-capsulebutton-${variant()}-compact`} onPress={() => act("CapsuleButton", variant())} />
              </V>
            );
          }}
        </Each>
      </Col>
    ),
  },
  HeadTabs: {
    render: () => {
      const view = signal<HeadView>("list");
      const index = () => HEAD_VIEWS.findIndex((tab) => tab.id === view());
      // A head as a page draws it: its row ends with the tabs, and its hairline dips under the current one.
      const Head = (headProps: { mobile: boolean }) => {
        const width = signal(0);
        return (
          <View
            class="relative z-10 w-64 flex-row items-center justify-end border-b border-transparent px-3"
            style={{ height: 57 }}
            onLayout={(event) => width.set(event.bounds.size.width)}
          >
            <HeadTabs tabs={HEAD_VIEWS} value={view()} onChange={(next) => view.set(next)} mobile={headProps.mobile} name={headProps.mobile ? "uig-headtab-phone" : "uig-headtab"} />
            <HeadTabsRule
              center={() => headTabsSagCenter(index(), headProps.mobile, { count: HEAD_VIEWS.length, width: width(), end: 12 })}
              color={String(token("line-soft"))}
            />
          </View>
        );
      };
      return (
        <Row>
          <V s="default"><Head mobile={false} /></V>
          <V l="mobile"><Head mobile /></V>
          <Text class="self-center text-xs text-muted-foreground" testID="uig-headtabs-echo">{t("uig_fixture_echo", { value: view() })}</Text>
        </Row>
      );
    },
  },
};
