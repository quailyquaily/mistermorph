// Gallery demos: the navigation's and the frame's parts (components/frame) and the Contacts page's
// cards (pages/contacts), with stand-in agents, pages and people. Choosing an agent or a page here
// only notes the action: nothing navigates and no agent is selected.
import { signal, Text, View } from "nsh";
import { AgentAvatar, AgentList, AgentPicker, AgentSwitcher, ConnectionMark } from "../../../components/frame/AgentSwitcher";
import { NavLink, NavList } from "../../../components/frame/Sidebar";
import { NAV_ITEMS_META } from "../../../lib/navOrder";
import defaultEndpointAvatar from "../../../assets/images/app_logo_current.svg";
import type { EndpointItem, NavItem } from "../../../lib/shell";
import { CARD_HEIGHT, ChannelMark, COMPACT_CARD_HEIGHT, ContactCard, KindAvatar, type LibraryGeometry } from "../../contacts/ContactCard";
import { ContactKindTabs } from "../../contacts/ContactKindTabs";
import type { ContactKind } from "../../contacts/contact-format";
import { act, Col, type DemoMap, LONG_TEXT, Row, t, V } from "../demo";

const AGENTS: EndpointItem[] = [
  { id: "ep_alpha", value: "ep_alpha", title: "Morph", image: defaultEndpointAvatar, connected: true },
  { id: "ep_beta", value: "ep_beta", title: "Atlas", image: defaultEndpointAvatar, connected: true },
  { id: "ep_long", value: "ep_long", title: LONG_TEXT, image: defaultEndpointAvatar, connected: true },
  { id: "ep_off", value: "ep_off", title: "Sleepy", image: defaultEndpointAvatar, connected: false },
];

/** The navigation's pages under addresses that open nothing; the gallery's own address is the active one. */
const navItems = (): NavItem[] =>
  NAV_ITEMS_META.map((item, index) =>
    "separator" in item
      ? { id: item.id, pagePath: "", title: "", icon: "", separator: true }
      : { id: index === 0 ? "/ui-components" : `/ui-components/demo${item.id}`, pagePath: item.id, title: t(item.titleKey), icon: item.icon },
  );

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

function PickerDemo() {
  const selected = signal("ep_beta");
  return (
    <Row>
      <V l="AgentPicker" row>
        <AgentPicker
          items={AGENTS}
          selectedValue={selected()}
          onSelect={(item) => {
            selected.set(item.value);
            act("AgentPicker", item.value);
          }}
          onOverview={() => act("AgentPicker", "overview")}
          trigger={(state) => (
            <View class={`flex-row items-center gap-2 rounded-(--radius) border px-3 py-2 ${state.open ? "border-blue" : "border-line"}`}>
              <AgentAvatar image={defaultEndpointAvatar} size={20} />
              <Text class="text-sm text-foreground">{AGENTS.find((item) => item.value === selected())?.title ?? ""}</Text>
            </View>
          )}
          accessibilityLabel={t("endpoint_switcher_label")}
          placement="bottom"
          align="start"
          testID="uig-agent-picker"
          partID="uig-agent-picker"
          optionPrefix="uig-agent-picker-option-"
          overviewTestID="uig-agent-picker-overview"
        />
      </V>
      <V l="AgentList" class="w-72">
        <View class="rounded-(--radius) border border-line-faint">
          <AgentList
            items={AGENTS}
            selectedValue={selected()}
            onSelect={(item) => {
              selected.set(item.value);
              act("AgentList", item.value);
            }}
            onOverview={() => act("AgentList", "overview")}
            open
            maxHeight={260}
            partID="uig-agent-list"
            optionPrefix="uig-agent-list-option-"
            overviewTestID="uig-agent-list-overview"
          />
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

function CardsDemo(props: { compact: boolean }) {
  const selected = signal("tg:1001");
  const geometry: LibraryGeometry = props.compact
    ? { columns: 3, cell: 104, pad: 0, gap: 8, height: COMPACT_CARD_HEIGHT, compact: true }
    : { columns: 3, cell: 168, pad: 0, gap: 12, height: CARD_HEIGHT, compact: false };
  const places = new Map<string, { index: number; geometry: LibraryGeometry }>();
  return (
    <View class="flex-row flex-wrap" style={{ gap: geometry.gap }}>
      <Each of={PEOPLE} key={(item) => item.contact_id}>
        {(item) => (
          <View style={{ width: geometry.cell, height: geometry.height }}>
            <ContactCard
              item={item()}
              index={0}
              geometry={{ ...geometry, columns: 1 }}
              motion={() => null}
              places={places}
              selected={selected() === item().contact_id}
              leaving={false}
              onPress={() => {
                selected.set(item().contact_id);
                act("ContactCard", item().contact_id);
              }}
            />
          </View>
        )}
      </Each>
    </View>
  );
}

export const FRAME_DEMOS: DemoMap = {
  AgentSwitcher: { render: () => <SwitcherDemo /> },
  AgentPicker: { render: () => <PickerDemo /> },
  AgentAvatar: {
    render: () => (
      <V l="size 20 / 32 / 48 · dim" row>
        <AgentAvatar image={defaultEndpointAvatar} size={20} />
        <AgentAvatar image={defaultEndpointAvatar} size={32} />
        <AgentAvatar image={defaultEndpointAvatar} size={48} />
        <AgentAvatar image={defaultEndpointAvatar} size={48} dim />
      </V>
    ),
  },
  ConnectionMark: {
    render: () => (
      <Row>
        <V s="on" row><ConnectionMark online /></V>
        <V s="off" row><ConnectionMark online={false} /></V>
      </Row>
    ),
  },
  NavList: {
    render: () => (
      <Row>
        <V s="default" class="w-52">
          <View class="rounded-(--radius) border border-line-faint bg-nav py-2">
            <NavList items={navItems()} onNavigate={(item) => act("NavList", item.pagePath)} testPrefix="uig-nav" />
          </View>
        </V>
        <V l="collapsed" class="w-14">
          <View class="rounded-(--radius) border border-line-faint bg-nav py-2">
            <NavList items={navItems()} collapsed onNavigate={(item) => act("NavList", item.pagePath)} testPrefix="uig-nav-collapsed" />
          </View>
        </V>
        <V l="mobile" class="w-64">
          <View class="rounded-(--radius) border border-line-faint bg-card py-2">
            <NavList items={navItems()} mobile onNavigate={(item) => act("NavList", item.pagePath)} testPrefix="uig-nav-mobile" />
          </View>
        </V>
      </Row>
    ),
    wide: true,
  },
  NavLink: {
    render: () => (
      <Row>
        <V s="selected" class="w-52"><NavLink item={navItems()[0]} onPress={() => act("NavLink", "active")} /></V>
        <V s="default" class="w-52"><NavLink item={navItems()[1]} onPress={() => act("NavLink", "idle")} /></V>
        <V l="collapsed" class="w-14"><NavLink item={navItems()[1]} collapsed onPress={() => act("NavLink", "collapsed")} /></V>
        <V s="long" class="w-52"><NavLink item={{ ...navItems()[2], title: LONG_TEXT }} onPress={() => act("NavLink", "long")} /></V>
      </Row>
    ),
  },
  KindAvatar: {
    render: () => (
      <Row>
        <V l="human · 64 / 44" row><KindAvatar item={PEOPLE[0]} size={64} /><KindAvatar item={PEOPLE[0]} size={44} /></V>
        <V l="agent" row><KindAvatar item={PEOPLE[2]} size={64} /></V>
        <V s="empty" l="unnamed" row><KindAvatar item={PEOPLE[4]} size={64} /></V>
      </Row>
    ),
  },
  ChannelMark: {
    render: () => (
      <V s="default" row>
        <Each of={["telegram", "slack", "line", "lark", "wechat", "x", "console", "unknown"]} key={(channel) => channel}>
          {(channel) => <ChannelMark channel={channel()} size={18} />}
        </Each>
      </V>
    ),
  },
  ContactCard: {
    render: () => (
      <Col>
        <V s="default"><CardsDemo compact={false} /></V>
        <V l="compact"><CardsDemo compact /></V>
      </Col>
    ),
    wide: true,
  },
  ContactKindTabs: {
    render: () => {
      const kind = signal<ContactKind>("human");
      return (
        <Row>
          <V s="default" row><ContactKindTabs value={kind()} onChange={(next) => kind.set(next)} mobile={false} /></V>
          <V l="mobile" row><ContactKindTabs value={kind()} onChange={(next) => kind.set(next)} mobile /></V>
          <Text class="self-center text-xs text-muted-foreground" testID="uig-kind-echo">{t("uig_fixture_echo", { value: kind() })}</Text>
        </Row>
      );
    },
  },
};
