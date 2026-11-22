// Gallery demos: the index and detail parts (components/knowledge), the stats and audit parts
// (components/observe) and the TODO page's small parts and its Flow view (components/todo).
import { signal, Text, View } from "nsh";
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
  MonoLabel,
  MoreTrigger,
  Note,
  PropertyList,
  PropertyRow,
  PropertyText,
  RowCount,
  SearchField,
  SubHeading,
  SwitchOnly,
  TurnCaret,
  WorkspaceTitle,
} from "../../../components/knowledge/parts";
import { SkillDocument } from "../../../components/knowledge/SkillDocument";
import { ModelLedger } from "../../../components/observe/ModelLedger";
import { AuditBadge, ObserveSection, Segmented } from "../../../components/observe/parts";
import { TodoCard } from "../../../components/todo/TodoCard";
import { FieldNote, TodoInput } from "../../../components/todo/TodoFields";
import { TodoFlow, type FlowJob, type FlowRunStep } from "../../../components/todo/TodoFlow";
import { RunMarker } from "../../../components/todo/TodoIndex";
import { TodoSelect } from "../../../components/todo/TodoSelect";
import { TodoViewToggle } from "../../../components/todo/TodoViewToggle";
import { Badge, Button, DropdownMenu, Muted } from "../../../components/ui";
import { StoreSkillDetail } from "../../skills/StoreSkillDetail";
import { act, acts, Col, type DemoMap, FIXED_ISO, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V } from "../demo";

const SKILL_DOC = [
  "# release-notes",
  "",
  "Drafts release notes from a list of merged changes.",
  "",
  "## Usage",
  "",
  "1. Collect the merged changes.",
  "2. Group them by area.",
  "3. Write one line for each.",
  "",
  "```sh",
  "release-notes --since v1.2.0",
  "```",
  "",
  "See [the guide](https://example.com/guide) for the format.",
].join("\n");

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

const MODELS = [
  { model: "example-large-1", requests: 40, total_tokens: 812000, input_tokens: 580000, output_tokens: 232000, cached_input_tokens: 290000, total_cost: 50.25, input_cost: 31.5, output_cost: 18.75, cached_input_cost: 2.9, cost_currency: "USD" },
  { model: "example-small-with-a-very-long-model-name-2026-03-14", requests: 2, total_tokens: 404, input_tokens: 200, output_tokens: 204, total_cost: 0.0358, cost_currency: "USD" },
  { model: "unpriced-local-model", requests: 7, total_tokens: 12000, input_tokens: 9000, output_tokens: 3000 },
];

function SegmentedDemo() {
  const range = signal(7);
  return (
    <Col>
      <V s="default">
        <Segmented
          label={t("uig_fixture_choice")}
          items={[1, 7, 30, 90].map((days) => ({ id: days, label: t("stats_daily_range_days", { count: days }) }))}
          value={range()}
          onChange={(id) => range.set(id)}
          testID="uig-segmented"
        />
        <Text class="text-xs text-muted-foreground" testID="uig-segmented-echo">{t("uig_fixture_echo", { value: range() })}</Text>
      </V>
      <V s="long">
        <Segmented items={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, label: `${t("uig_fixture_option", { n })} ${t("uig_fixture_title")}` }))} value={range()} onChange={(id) => range.set(id)} />
      </V>
    </Col>
  );
}

// TodoFlow on jobs of its own: the demo is the page, so an edit changes its jobs (and is noted).
// Five jobs: the first runs (a pulse along its links for each new result); the fourth joins two
// inputs; the fifth uses the first past a column (its link goes round) and is off. Replay plays a
// chain in which the third failed.
function TodoFlowDemo() {
  const name = (n: number) => t("uig_fixture_option", { n });
  const flowJob = (n: number, uses: number[], more: Partial<FlowJob> = {}): FlowJob => ({
    id: `job-${n}`,
    title: n === 4 ? `${name(n)} ${LONG_TEXT}` : name(n),
    note: t("uig_fixture_title"),
    enabled: true,
    running: false,
    uses: uses.map((used) => ({ job_id: `job-${used}` })),
    join: "all",
    ...more,
  });
  const jobs = signal<FlowJob[]>([
    flowJob(1, [], { running: true }),
    flowJob(2, [1]),
    flowJob(3, [1]),
    flowJob(4, [2, 3]),
    flowJob(5, [2, 1], { enabled: false }),
    flowJob(6, []),
  ]);
  const chain = (): FlowRunStep[] => [
    { job_id: "job-1", status: "done", note: t("uig_fixture_progress", { percent: 100 }) },
    { job_id: "job-2", status: "done", note: t("uig_fixture_progress", { percent: 100 }) },
    { job_id: "job-3", status: "failed", note: t("uig_fixture_error") },
    { job_id: "job-4", status: "skipped", note: t("uig_state_empty") },
  ];
  const replay = signal<FlowRunStep[] | null>(null);
  const busy = useFlag(false);
  const change = (id: string, edit: (job: FlowJob) => FlowJob) => jobs.update((all) => all.map((job) => (job.id === id ? edit(job) : job)));
  const flow = (mobile: boolean) => (
    <TodoFlow
      jobs={jobs()}
      replay={replay()}
      mobile={mobile}
      busy={busy.on()}
      onOpenJob={acts("onOpenJob")}
      onAddUse={(id, used) => {
        act("onAddUse", `${id} ${used}`);
        change(id, (job) => ({ ...job, uses: [...job.uses, { job_id: used }] }));
      }}
      onRemoveUse={(id, used) => {
        act("onRemoveUse", `${id} ${used}`);
        change(id, (job) => ({ ...job, uses: job.uses.filter((use) => use.job_id !== used) }));
      }}
      onSetJoin={(id, join) => {
        act("onSetJoin", `${id} ${join}`);
        change(id, (job) => ({ ...job, join }));
      }}
    />
  );
  return (
    <Col>
      <Row>
        <Button size="xs" variant="outlined" label={t("uig_fixture_replay")} selected={!!replay()} onPress={() => replay.set(replay() ? null : chain())} testID="uig-flow-replay" />
        <Button size="xs" variant="outlined" label={t("uig_state_busy")} selected={busy.on()} onPress={busy.toggle} testID="uig-flow-busy" />
      </Row>
      <V s="default">
        <View class="h-[420px] rounded-(--radius) border border-line-faint" testID="uig-flow">{flow(false)}</View>
      </V>
      <V s="readonly" l="mobile">
        <View class="h-[420px] max-w-[390px] rounded-(--radius) border border-line-faint">{flow(true)}</View>
      </V>
    </Col>
  );
}

// RunMarker spreads its layout probe on its view; the page always gives it one (TodoIndex), and on
// the web a missing one cannot be spread. The demos give it an empty probe.
const NO_PROBE = {} as never;

const TODO_ITEMS = [
  { id: "a", value: "a", title: "Alpha profile", subtitle: "example-large-1", icon: "PhCube" },
  { id: "b", value: "b", title: "Beta profile", subtitle: "example-small-2", icon: "PhCpu" },
  { id: "c", value: "c", title: LONG_TEXT, subtitle: LONG_WORD },
];

function TodoPartsDemo() {
  const current = signal("a");
  const title = useText("Water the plants");
  const count = useText("3");
  return (
    <Row>
      <V l="TodoInput" class="w-72">
        <TodoInput value={title.get()} onChange={title.set} accessibilityLabel={t("uig_fixture_name")} strong placeholder={t("uig_fixture_placeholder")} />
        <TodoInput value={count.get()} onChange={count.set} prepend={t("uig_fixture_name")} accessibilityLabel={t("uig_fixture_name")} keyboardType="number-pad" mono />
        <TodoInput value="read only" onChange={() => {}} accessibilityLabel={t("uig_fixture_name")} disabled prepend={t("uig_state_disabled")} />
        <FieldNote>{t("uig_fixture_hint")}</FieldNote>
      </V>
      <V l="TodoSelect" class="w-72">
        <TodoSelect label={t("uig_fixture_choice")} items={TODO_ITEMS} current={TODO_ITEMS.find((item) => item.value === current())} onChange={(value) => current.set(value)} searchable testID="uig-todo-select" />
        <TodoSelect label={t("uig_fixture_choice")} items={TODO_ITEMS} current={null} placeholder={t("uig_fixture_placeholder")} onChange={(value) => current.set(value)} />
        <TodoSelect label={t("uig_fixture_choice")} items={TODO_ITEMS} current={TODO_ITEMS[1]} disabled />
      </V>
    </Row>
  );
}

const storeSkill = (installed: boolean, updateAvailable: boolean) =>
  ({
    id: "release-notes",
    name: "release-notes",
    description: LONG_TEXT,
    author: "Example Author",
    version: "1.4.0",
    installedVersion: installed ? "1.3.0" : "",
    license: "MIT",
    repo: "https://example.com/skills",
    homepage: "https://example.com/skills/release-notes",
    commit: "0123abc",
    tags: ["writing", "release", "synthetic"],
    requirements: ["git"],
    authProfiles: ["example-profile"],
    installed,
    updateAvailable,
  }) as never;

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
  WorkspaceTitle: {
    render: () => (
      <Col>
        <V s="default"><View class="flex-row"><WorkspaceTitle text={t("uig_fixture_title")} /></View></V>
        <V s="long"><View class="w-64 flex-row"><WorkspaceTitle text={LONG_TEXT} /></View></V>
      </Col>
    ),
  },
  HeadButton: {
    render: () => (
      <Row>
        <V s="default" row>
          <HeadButton icon="PhPlus" title={t("uig_fixture_add")} onPress={() => act("HeadButton", "add")} />
          <HeadButton icon="PhArrowClockwise" title={t("action_refresh")} onPress={() => act("HeadButton", "refresh")} />
        </V>
        <V s="disabled" row><HeadButton icon="PhPlus" title={t("uig_fixture_add")} disabled onPress={() => {}} /></V>
      </Row>
    ),
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
  RowCount: {
    render: () => (
      <V s="default" row><RowCount value={0} /><RowCount value={7} /><RowCount value={128} /><RowCount value="9.9k" /></V>
    ),
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
  PropertyList: {
    render: () => (
      <PropertyList>
        <PropertyRow label={t("uig_fixture_name")}><PropertyText text="Morph" /></PropertyRow>
        <PropertyRow label={LONG_TEXT}><PropertyText text={LONG_WORD} mono /></PropertyRow>
        <PropertyRow label={t("uig_fixture_toggle")} center><Badge tone="ok" label={t("uig_state_on")} /></PropertyRow>
      </PropertyList>
    ),
  },
  LinkText: {
    render: () => (
      <Col>
        <V s="default" row><LinkText text="https://example.com/docs" onPress={() => act("LinkText")} testID="uig-linktext" /></V>
        <V s="long"><View class="w-64"><LinkText text={`https://example.com/${LONG_WORD}`} onPress={() => act("LinkText", "long")} /></View></V>
      </Col>
    ),
  },
  MobileBar: {
    render: () => (
      <Col>
        <V s="default"><View class="border border-line-faint"><MobileBar title={t("uig_fixture_title")} backLabel={t("uig_fixture_back")} onBack={() => act("MobileBar", "back")} actions={<HeadButton icon="PhPencilSimple" title={t("uig_fixture_menu")} onPress={() => act("MobileBar", "edit")} />} /></View></V>
        <V s="long"><View class="border border-line-faint"><MobileBar title={LONG_TEXT} backLabel={t("uig_fixture_back")} onBack={() => act("MobileBar", "back")} /></View></V>
      </Col>
    ),
  },
  "SubHeading-knowledge-parts": {
    render: () => (
      <Col>
        <V s="default"><SubHeading text={t("uig_fixture_title")} /></V>
        <V l="right"><SubHeading text={t("uig_fixture_title")} right={<RowCount value={4} />} /></V>
      </Col>
    ),
  },
  MonoLabel: { render: () => <V s="default" row><MonoLabel text={t("uig_fixture_title")} /><MonoLabel text="ID · 0001" /></V> },
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
  SkillDocument: { render: () => <SkillDocument source={SKILL_DOC} onLinkPress={acts("SkillDocument link")} />, wide: true },
  StoreSkillDetail: {
    render: () => {
      const busy = useFlag(false);
      const state = signal<"new" | "installed" | "update" | "error">("new");
      return (
        <Col>
          <Segmented
            items={(["new", "installed", "update", "error"] as const).map((id) => ({ id, label: id }))}
            value={state()}
            onChange={(id) => {
              state.set(id);
              busy.set(false);
            }}
          />
          <View class="h-[460px] overflow-hidden rounded-(--radius) border border-line-faint">
            <StoreSkillDetail
              skill={storeSkill(state() === "installed" || state() === "update", state() === "update")}
              links={{ folder: "https://example.com/skills/release-notes", document: "https://example.com/skills/release-notes/SKILL.md" }}
              doc={{ id: "release-notes", content: SKILL_DOC, loading: false, failed: false }}
              documentSource={SKILL_DOC}
              filesSummary={t("uig_fixture_count_many", { count: 2 })}
              installBusy={busy.on()}
              installErr={state() === "error" ? t("uig_fixture_error") : ""}
              onInstall={(update) => {
                busy.set(true);
                act("StoreSkillDetail install", update ? "update" : "install");
              }}
              onOpenInstalled={() => act("StoreSkillDetail", "open installed")}
              onClose={() => act("StoreSkillDetail", "close")}
            />
          </View>
        </Col>
      );
    },
    wide: true,
  },
  ModelLedger: {
    render: () => (
      <Col>
        <V s="default"><ModelLedger models={MODELS} scope="uig" /></V>
        <V s="empty"><ModelLedger models={[]} scope="uig-empty" /></V>
      </Col>
    ),
    wide: true,
  },
  Segmented: { render: () => <SegmentedDemo /> },
  ObserveSection: {
    render: () => (
      <Col>
        <V l="boxed">
          <ObserveSection variant="boxed" title={t("uig_fixture_title")} meta={<Badge tone="info" label={t("uig_fixture_count_many", { count: 3 })} />} actions={<Button variant="plain" size="xs" label={t("action_refresh")} onPress={() => act("ObserveSection")} />}>
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
  TodoCard: {
    render: () => (
      <Col>
        <V s="default">
          <TodoCard title={t("uig_fixture_title")} meta={t("uig_fixture_count_many", { count: 3 })} actions={<Button variant="plain" size="xs" label={t("action_refresh")} onPress={() => act("TodoCard")} />}>
            <Muted>{LONG_TEXT}</Muted>
          </TodoCard>
        </V>
        <V l="panel · list">
          <TodoCard title={LONG_TEXT} panel list>
            <View class="px-4 py-2"><Text class="text-sm text-foreground">{t("uig_fixture_option", { n: 1 })}</Text></View>
            <View class="px-4 py-2"><Text class="text-sm text-foreground">{t("uig_fixture_option", { n: 2 })}</Text></View>
          </TodoCard>
        </V>
      </Col>
    ),
  },
  FieldNote: { render: () => <Col><V s="default"><FieldNote>{t("uig_fixture_hint")}</FieldNote></V><V s="long"><FieldNote>{LONG_TEXT}</FieldNote></V></Col> },
  TodoInput: { render: () => <TodoPartsDemo /> },
  RunMarker: {
    render: () => (
      <Row>
        <V s="on" row><RunMarker run={null} enabled probe={NO_PROBE} /></V>
        <V s="off" row><RunMarker run={null} enabled={false} probe={NO_PROBE} /></V>
        <V l="running" row><RunMarker run={{ state: "running", manual: false, startedAt: FIXED_ISO, runID: "run-1", stopping: false }} enabled probe={NO_PROBE} /></V>
        <V l="pending" row><RunMarker run={{ state: "pending", manual: true, startedAt: FIXED_ISO, runID: "run-2", stopping: false }} enabled probe={NO_PROBE} /></V>
      </Row>
    ),
  },
  TodoFlow: { render: () => <TodoFlowDemo />, wide: true },
  TodoViewToggle: {
    render: () => {
      const calendar = useFlag(false);
      return (
        <V s={calendar.on() ? "on" : "off"} row>
          <TodoViewToggle calendar={calendar.on()} onPress={calendar.toggle} />
        </V>
      );
    },
  },
};
