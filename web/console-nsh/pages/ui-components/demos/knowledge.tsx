// Gallery demos: the index and detail parts (components/knowledge), the stats and audit parts
// (components/observe) and the TODO page's small parts and its Flow view (components/todo).
import { signal, View } from "nsh";
import {
  Blocks,
  DetailCard,
  HeadButton,
  IndexColumn,
  IndexDivider,
  IndexRow,
  IndexSearch,
  InlineNotice,
  LinkText,
  MobileBar,
  MoreTrigger,
  Note,
  PropertyList,
  PropertyRow,
  PropertyText,
  RowCount,
  SearchField,
  SwitchOnly,
  TurnCaret,
} from "../../../components/knowledge/parts";
import { AuditBadge, ObserveSection } from "../../../components/observe/parts";
import { Badge, Button, DropdownMenu, Muted } from "../../../components/ui";
import { act, Col, type DemoMap, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V } from "../demo";

const ROWS = [
  { id: "r1", title: "Weekly planning notes", meta: "Updated on a fixed synthetic date" },
  { id: "r2", title: LONG_TEXT, meta: LONG_TEXT },
  { id: "r3", title: "项目回顾与下一步计划", meta: "中文元信息" },
  { id: "r4", title: "週次レビューのメモ", meta: "日本語のメタ情報" },
];

function IndexColumnDemo() {
  const query = useText("");
  const active = signal("r1");
  const rows = () => ROWS.filter((row) => row.title.toLowerCase().includes(query.get().trim().toLowerCase()));
  return (
    <Row>
      <V s="default" class="w-80">
        <View class="h-96 overflow-hidden rounded-(--radius) border border-line-faint">
          <IndexColumn
            title={t("uig_fixture_title")}
            label={t("uig_fixture_title")}
            fill
            actions={<HeadButton icon="PhPlus" title={t("uig_fixture_add")} onPress={() => act("HeadButton", "add")} />}
            search={<IndexSearch value={query.get()} onChange={query.set} placeholder={t("uig_filter_placeholder")} testID="uig-index-search" clearLabel={t("uig_filter_clear")} />}
          >
            <IndexDivider label={t("uig_fixture_count_many", { count: rows().length })} />
            <Each of={rows()} key={(row) => row.id}>
              {(row) => (
                <IndexRow
                  title={row().title}
                  meta={row().meta}
                  active={active() === row().id}
                  trailing={<RowCount value={row().title.length} />}
                  onPress={() => {
                    active.set(row().id);
                    act("IndexRow", row().id);
                  }}
                  testID={`uig-index-row-${row().id}`}
                />
              )}
            </Each>
            <If when={rows().length === 0}>
              <Note text={t("uig_fixture_empty_title")} class="px-4 py-3" />
            </If>
          </IndexColumn>
        </View>
      </V>
      <V s="loading" class="w-80">
        <View class="h-96 overflow-hidden rounded-(--radius) border border-line-faint">
          <IndexColumn title={t("uig_fixture_title")} fill>
            <View class="p-3"><Blocks count={5} label={t("msg_loading")} /></View>
          </IndexColumn>
        </View>
      </V>
    </Row>
  );
}

function DetailDemo() {
  return (
    <Col>
      <V s="default">
        <DetailCard
          title={t("uig_fixture_title")}
          meta={t("uig_fixture_count_many", { count: 3 })}
          actions={
            <DropdownMenu
              align="end"
              trigger={<MoreTrigger label={t("uig_fixture_menu")} />}
              items={[
                { id: "copy", label: t("action_copy"), icon: "PhCopy", onSelect: () => act("DetailCard menu", "copy") },
                { id: "delete", label: t("action_delete"), icon: "PhTrash", danger: true, onSelect: () => act("DetailCard menu", "delete") },
              ]}
            />
          }
        >
          <PropertyList>
            <PropertyRow label={t("uig_fixture_name")}><PropertyText text="Morph" /></PropertyRow>
            <PropertyRow label="ID"><PropertyText text="mem_2026_03_14_0001" mono /></PropertyRow>
            <PropertyRow label={t("uig_fixture_notes")}><PropertyText text={LONG_TEXT} /></PropertyRow>
            <PropertyRow label={t("uig_fixture_address")} center><LinkText text="https://example.com/a/synthetic/link" onPress={() => act("LinkText")} /></PropertyRow>
          </PropertyList>
        </DetailCard>
      </V>
      <V s="long" l="literal">
        <DetailCard title={LONG_TEXT} literal meta={<Badge tone="info" label={t("uig_fixture_count_one")} />}>
          <Muted>{LONG_WORD}</Muted>
        </DetailCard>
      </V>
    </Col>
  );
}

export const KNOWLEDGE_DEMOS: DemoMap = {
  "InlineNotice-knowledge-parts": {
    render: () => (
      <Col>
        <V l="info"><InlineNotice type="info" text={t("uig_fixture_notice", { type: "info" })} /></V>
        <V l="warning"><InlineNotice type="warning" text={t("uig_fixture_notice", { type: "warning" })} /></V>
        <V l="error"><InlineNotice type="error" text={t("uig_fixture_notice", { type: "error" })} /></V>
        <V s="long"><InlineNotice type="warning" text={`${LONG_TEXT} ${LONG_WORD}`} /></V>
      </Col>
    ),
  },
  Note: {
    render: () => (
      <Col>
        <V s="default"><Note text={t("uig_fixture_hint")} /></V>
        <V s="long"><Note text={LONG_TEXT} /></V>
      </Col>
    ),
  },
  SearchField: {
    render: () => {
      const a = useText("");
      const b = useText("needle");
      return (
        <Row>
          <V s="empty" class="w-64"><SearchField value={a.get()} onChange={a.set} placeholder={t("uig_filter_placeholder")} onSubmit={() => act("SearchField", a.get())} /></V>
          <V s="filled" l="icon · large" class="w-64"><SearchField value={b.get()} onChange={b.set} placeholder={t("uig_filter_placeholder")} icon large /></V>
        </Row>
      );
    },
  },
  IndexSearch: {
    render: () => {
      const a = useText("");
      const b = useText("needle");
      return (
        <Row>
          <V s="empty" class="w-64"><IndexSearch value={a.get()} onChange={a.set} placeholder={t("uig_filter_placeholder")} testID="uig-indexsearch-a" /></V>
          <V s="filled" l="mobile" class="w-64"><IndexSearch value={b.get()} onChange={b.set} placeholder={t("uig_filter_placeholder")} mobile testID="uig-indexsearch-b" clearLabel={t("uig_filter_clear")} onClear={() => act("IndexSearch", "clear")} /></V>
        </Row>
      );
    },
  },
  IndexColumn: { render: () => <IndexColumnDemo />, wide: true },
  IndexDivider: {
    render: () => (
      <Col>
        <V s="default"><IndexDivider label={t("uig_fixture_title")} /></V>
        <V s="long"><View class="w-64"><IndexDivider label={LONG_TEXT} /></View></V>
      </Col>
    ),
  },
  IndexRow: {
    render: () => {
      const active = signal("b");
      return (
        <Col class="max-w-96">
          <V s="default"><IndexRow title={t("uig_fixture_title")} meta={t("uig_fixture_hint")} onPress={() => active.set("a")} active={active() === "a"} /></V>
          <V s="selected" l="icon · trailing"><IndexRow title={t("uig_fixture_title")} meta={t("uig_fixture_hint")} icon="PhFileText" trailing={<RowCount value={12} />} onPress={() => active.set("b")} active={active() === "b"} /></V>
          <V s="long" l="metaLines 2 · metaFade"><IndexRow title={LONG_TEXT} meta={LONG_TEXT} metaLines={2} metaFade onPress={() => active.set("c")} active={active() === "c"} /></V>
        </Col>
      );
    },
  },
  Blocks: {
    render: () => (
      <Row>
        <V s="loading" l="count 3" class="w-56"><Blocks count={3} label={t("msg_loading")} /></V>
        <V s="loading" l="height 24" class="w-56"><Blocks count={4} height={24} /></V>
      </Row>
    ),
  },
  DetailCard: { render: () => <DetailDemo />, wide: true },
  MoreTrigger: { render: () => <V s="default" row><MoreTrigger label={t("uig_fixture_menu")} /></V> },
  MobileBar: {
    render: () => (
      <Col>
        <V s="default"><View class="border border-line-faint"><MobileBar title={t("uig_fixture_title")} backLabel={t("uig_fixture_back")} onBack={() => act("MobileBar", "back")} actions={<HeadButton icon="PhPencilSimple" title={t("uig_fixture_menu")} onPress={() => act("MobileBar", "edit")} />} /></View></V>
        <V s="long"><View class="border border-line-faint"><MobileBar title={LONG_TEXT} backLabel={t("uig_fixture_back")} onBack={() => act("MobileBar", "back")} /></View></V>
      </Col>
    ),
  },
  SwitchOnly: {
    render: () => {
      const on = useFlag(true);
      return (
        <Row>
          <V s="default" row><SwitchOnly checked={on.on()} onChange={on.set} label={t("uig_fixture_toggle")} testID="uig-switchonly" /></V>
          <V s="disabled" row><SwitchOnly checked label={t("uig_fixture_toggle")} disabled /><SwitchOnly checked={false} label={t("uig_fixture_toggle")} disabled /></V>
        </Row>
      );
    },
  },
  TurnCaret: {
    render: () => {
      const open = useFlag(false);
      return (
        <V s={open.on() ? "open" : "closed"} row>
          <TurnCaret open={open.on()} />
          <TurnCaret open={open.on()} size={18} turn={180} icon="PhCaretDown" />
          <Button variant="outlined" size="xs" label={t("uig_fixture_toggle")} onPress={open.toggle} />
        </V>
      );
    },
  },
  ObserveSection: {
    render: () => (
      <Col>
        <V l="boxed">
          <ObserveSection variant="boxed" title={t("uig_fixture_title")} meta={<Badge tone="info" label={t("uig_fixture_count_many", { count: 3 })} />} actions={<Button variant="plain" size="xs" label={t("action_save")} onPress={() => act("ObserveSection")} />}>
            <Muted>{LONG_TEXT}</Muted>
          </ObserveSection>
        </V>
        <V l="plain">
          <ObserveSection variant="plain" title={LONG_TEXT}><Muted>{t("uig_fixture_hint")}</Muted></ObserveSection>
        </V>
      </Col>
    ),
  },
  AuditBadge: {
    render: () => (
      <Row>
        <Each of={["default", "warning", "danger", "success", "primary"] as const} key={(type) => type}>
          {(type) => (
            <V l={type()} row>
              <AuditBadge badge={{ type: type(), variant: "filled" }} label={type()} />
              <AuditBadge badge={{ type: type(), variant: "outlined" }} label={type()} />
            </V>
          )}
        </Each>
      </Row>
    ),
  },
};
