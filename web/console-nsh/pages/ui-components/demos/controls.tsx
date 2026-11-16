// Gallery demos: the design system's controls and marks (components/ui.tsx).
import { signal, Text, View } from "nsh";
import {
  Badge,
  BackButton,
  Button,
  BusyBeam,
  Card,
  CheckboxField,
  CircleButton,
  Divider,
  DropdownMenu,
  EmptyState,
  Fab,
  Heading,
  Icon,
  Kicker,
  LoadingLine,
  Markdown,
  MenuIconTrigger,
  Muted,
  PageBar,
  PageTitle,
  ProgressBar,
  Section,
  SelectField,
  Skeleton,
  Spinner,
  StatusMark,
  Tabs,
  TextField,
  Tip,
  TipButton,
  Toggle,
  type ButtonSize,
  type ButtonVariant,
  type StatusState,
} from "../../../components/ui";
import { LanguageSelector } from "../../../components/LanguageSelector";
import { act, acts, Col, type DemoMap, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V, Wide } from "../demo";

const BUTTON_VARIANTS: ButtonVariant[] = ["primary", "outlined", "plain", "danger", "highlight", "ghost-danger"];
const BUTTON_SIZES: ButtonSize[] = ["md", "sm", "xs", "xxs"];
const STATUS_STATES: StatusState[] = ["on", "off", "pending", "error", "unread", "running"];
const TONES = ["neutral", "info", "ok", "warn", "danger"] as const;

const MARKDOWN = [
  "## Heading two",
  "",
  "A paragraph with **bold**, *italic*, `inline code` and a [link](https://example.com/docs).",
  "",
  "- first item",
  "- second item with 中文 and 日本語",
  "",
  "1. numbered",
  "2. list",
  "",
  "> A quotation that runs to a second line when the column is narrow enough to need one.",
  "",
  "| Column | Value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "| beta | 2 |",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
].join("\n");

function ButtonDemo() {
  const busy = useFlag(false);
  const picked = useFlag(false);
  return (
    <Col>
      <Each of={BUTTON_VARIANTS} key={(variant) => variant}>
        {(variant) => (
          <V l={variant()} row>
            <Button variant={variant()} label={t("action_save")} onPress={() => act("Button", variant())} testID={`uig-button-${variant()}`} />
            <Button variant={variant()} label={t("action_save")} icon="PhCheck" onPress={() => act("Button", variant())} />
            <Button variant={variant()} label={t("action_save")} disabled />
            <Button variant={variant()} label={t("action_save")} loading />
          </V>
        )}
      </Each>
      <V l="size md / sm / xs / xxs" row>
        <Each of={BUTTON_SIZES} key={(size) => size}>
          {(size) => <Button variant="outlined" size={size()} label={t("action_refresh")} icon="PhArrowClockwise" onPress={() => act("Button size", size())} />}
        </Each>
      </V>
      <V l="iconOnly" row>
        <Each of={BUTTON_SIZES} key={(size) => size}>
          {(size) => <Button variant="outlined" size={size()} iconOnly icon="PhArrowClockwise" title={t("action_refresh")} onPress={() => act("Button icon", size())} />}
        </Each>
        <Button variant="plain" iconOnly icon="PhTrash" title={t("action_delete")} disabled />
      </V>
      <V s="selected" row>
        <Button variant="outlined" label={t("uig_fixture_toggle")} icon="PhPushPin" selected={picked.on()} onPress={picked.toggle} testID="uig-button-selected" />
        <Text class="text-xs text-muted-foreground" testID="uig-button-selected-state">{picked.on() ? t("uig_state_on") : t("uig_state_off")}</Text>
      </V>
      <V s="loading" row>
        <Button
          label={busy.on() ? t("uig_fixture_working") : t("uig_fixture_start")}
          loading={busy.on()}
          onPress={() => {
            busy.set(true);
            act("Button", "busy");
          }}
          testID="uig-button-busy"
        />
        <Button variant="plain" label={t("uig_fixture_reset")} onPress={() => busy.set(false)} testID="uig-button-busy-reset" />
      </V>
      <V s="long" l="wrap / block">
        <View class="max-w-70 gap-2">
          <Button variant="outlined" label={LONG_TEXT} wrap block onPress={() => act("Button", "wrap")} />
          <Button variant="outlined" label={LONG_TEXT} block onPress={() => act("Button", "cut")} />
        </View>
      </V>
    </Col>
  );
}

function CircleButtonDemo() {
  const on = useFlag(true);
  return (
    <Row>
      <Each of={["plain", "outlined", "primary", "danger", "close"] as const} key={(variant) => variant}>
        {(variant) => (
          <V l={variant()} row>
            <CircleButton title={variant()} icon={variant() === "close" ? "PhX" : "PhPlus"} variant={variant()} onPress={() => act("CircleButton", variant())} />
            <CircleButton title={`${variant()} sm`} icon={variant() === "close" ? "PhX" : "PhPlus"} variant={variant()} size="sm" onPress={() => act("CircleButton", variant())} />
            <CircleButton title={`${variant()} disabled`} icon={variant() === "close" ? "PhX" : "PhPlus"} variant={variant()} disabled />
          </V>
        )}
      </Each>
      <V s="selected" row>
        <CircleButton title={t("uig_fixture_toggle")} icon="PhMicrophone" selected={on.on()} onPress={on.toggle} />
      </V>
    </Row>
  );
}

function TextFieldDemo() {
  const name = useText("Morph");
  const empty = useText("");
  const secret = useText("correct horse battery staple");
  const notes = useText(`${LONG_TEXT}\n\n${LONG_WORD}`);
  const search = useText("needle");
  const bad = useText("not an address");
  return (
    <Col>
      <Row>
        <V s="default" class="w-64">
          <TextField label={t("uig_fixture_name")} hint={t("uig_fixture_hint")} value={name.get()} onChange={name.set} testID="uig-textfield-name" />
          <Text class="text-xs text-muted-foreground" testID="uig-textfield-echo">{t("uig_fixture_echo", { value: name.get() })}</Text>
        </V>
        <V s="empty" class="w-64">
          <TextField label={t("uig_fixture_name")} placeholder={t("uig_fixture_placeholder")} value={empty.get()} onChange={empty.set} />
        </V>
        <V s="error" class="w-64">
          <TextField label={t("uig_fixture_address")} error={t("uig_fixture_error")} value={bad.get()} onChange={bad.set} keyboardType="url" />
        </V>
        <V s="disabled" class="w-64">
          <TextField label={t("uig_fixture_name")} value="Morph" disabled />
        </V>
        <V s="readonly" l="mono" class="w-64">
          <TextField label="ID" value="ep_console_local" readonly mono />
        </V>
        <V l="masked" class="w-64">
          <TextField label={t("uig_fixture_secret")} value={secret.get()} onChange={secret.set} masked />
        </V>
        <V l="leadingIcon · clearable" class="w-64">
          <TextField value={search.get()} onChange={search.set} leadingIcon="PhMagnifyingGlass" clearable placeholder={t("uig_filter_placeholder")} onClear={() => act("TextField", "clear")} />
        </V>
        <V l="size sm / xs" class="w-64">
          <TextField size="sm" value={name.get()} onChange={name.set} />
          <TextField size="xs" value={name.get()} onChange={name.set} />
        </V>
      </Row>
      <V s="long" l="multiline rows=4">
        <TextField multiline rows={4} value={notes.get()} onChange={notes.set} label={t("uig_fixture_notes")} />
      </V>
    </Col>
  );
}

function ToggleDemo() {
  const a = useFlag(true);
  const b = useFlag(false);
  return (
    <Row>
      <V s="default" class="w-72">
        <Toggle checked={a.on()} onChange={a.set} label={t("uig_fixture_toggle")} hint={t("uig_fixture_hint")} testID="uig-toggle" />
        <Text class="text-xs text-muted-foreground" testID="uig-toggle-state">{a.on() ? t("uig_state_on") : t("uig_state_off")}</Text>
      </V>
      <V s="long" class="w-72">
        <Toggle checked={b.on()} onChange={b.set} label={LONG_TEXT} hint={LONG_TEXT} />
      </V>
      <V s="disabled" class="w-56">
        <Toggle checked label={t("uig_fixture_toggle")} disabled />
        <Toggle checked={false} label={t("uig_fixture_toggle")} disabled />
      </V>
      <V l="hideLabel" row>
        <Toggle checked={b.on()} onChange={b.set} label={t("uig_fixture_toggle")} hideLabel />
      </V>
    </Row>
  );
}

function CheckboxDemo() {
  const a = useFlag(true);
  const b = useFlag(false);
  return (
    <Row>
      <V s="default">
        <CheckboxField checked={a.on()} onChange={a.set} label={t("uig_fixture_toggle")} />
      </V>
      <V s="long" class="w-full">
        <Wide><CheckboxField checked={b.on()} onChange={b.set} label={LONG_TEXT} /></Wide>
      </V>
      <V l="indeterminate">
        <CheckboxField checked={false} indeterminate label={t("uig_fixture_toggle")} />
      </V>
      <V s="disabled">
        <CheckboxField checked label={t("uig_fixture_toggle")} disabled />
        <CheckboxField checked={false} label={t("uig_fixture_toggle")} disabled />
      </V>
    </Row>
  );
}

const fruit = () => [
  { value: "apple", label: t("uig_fixture_option", { n: 1 }), description: t("uig_fixture_hint") },
  { value: "pear", label: t("uig_fixture_option", { n: 2 }) },
  { value: "plum", label: t("uig_fixture_option", { n: 3 }), disabled: true },
  { value: "long", label: LONG_TEXT },
];
const many = () => Array.from({ length: 40 }, (_, i) => ({ value: `item-${i + 1}`, label: t("uig_fixture_option", { n: i + 1 }) }));

function SelectDemo() {
  const one = signal<string | null>("apple");
  const none = signal<string | null>(null);
  const big = signal<string | null>("item-7");
  return (
    <Row>
      <V s="default" class="w-64">
        <SelectField label={t("uig_fixture_choice")} hint={t("uig_fixture_hint")} items={fruit()} value={one()} onChange={(value) => one.set(value)} testID="uig-select" />
        <Text class="text-xs text-muted-foreground" testID="uig-select-echo">{t("uig_fixture_echo", { value: one() ?? "" })}</Text>
      </V>
      <V s="empty" class="w-64">
        <SelectField label={t("uig_fixture_choice")} placeholder={t("uig_fixture_placeholder")} items={fruit()} value={none()} onChange={(value) => none.set(value)} />
      </V>
      <V l="searchable · 40" class="w-64">
        <SelectField searchable items={many()} value={big()} onChange={(value) => big.set(value)} />
      </V>
      <V s="disabled" class="w-64">
        <SelectField items={fruit()} value="pear" disabled />
      </V>
      <V l="size sm / xs" class="w-64">
        <SelectField size="sm" items={fruit()} value={one()} onChange={(value) => one.set(value)} />
        <SelectField size="xs" items={fruit()} value={one()} onChange={(value) => one.set(value)} />
      </V>
    </Row>
  );
}

function MenuDemo() {
  const sort = signal("name");
  const entries = () => [
    { id: "name", label: t("uig_fixture_option", { n: 1 }), icon: "PhListBullets" as const, checked: sort() === "name", onSelect: () => sort.set("name") },
    { id: "date", label: t("uig_fixture_option", { n: 2 }), description: t("uig_fixture_hint"), checked: sort() === "date", onSelect: () => sort.set("date") },
    { id: "off", label: t("uig_fixture_option", { n: 3 }), disabled: true },
    { id: "sep", separator: true },
    { id: "delete", label: t("action_delete"), icon: "PhTrash" as const, danger: true, onSelect: () => act("DropdownMenu", "delete") },
  ];
  return (
    <Row>
      <V s="default" row>
        <DropdownMenu label={t("uig_fixture_choice")} trigger={<MenuIconTrigger label={t("uig_fixture_menu")} testID="uig-menu-trigger" />} items={entries()} />
        <Text class="text-xs text-muted-foreground" testID="uig-menu-echo">{t("uig_fixture_echo", { value: sort() })}</Text>
      </V>
      <V l="MenuIconTrigger icon · align end" row>
        <DropdownMenu align="end" trigger={<MenuIconTrigger icon="PhFunnelSimple" label={t("uig_fixture_menu")} />} items={entries()} />
      </V>
      <V s="disabled" row>
        <DropdownMenu disabled trigger={<MenuIconTrigger label={t("uig_fixture_menu")} />} items={entries()} />
      </V>
    </Row>
  );
}

function TabsDemo() {
  const tab = signal("b");
  const icon = signal("list");
  const items = () => [
    { id: "a", label: t("uig_fixture_option", { n: 1 }), count: 3 },
    { id: "b", label: t("uig_fixture_option", { n: 2 }), count: 128 },
    { id: "c", label: t("uig_fixture_option", { n: 3 }), disabled: true },
    { id: "d", label: t("uig_fixture_option", { n: 4 }) },
  ];
  return (
    <Col>
      <V s="default">
        <Wide><Tabs items={items()} value={tab()} onChange={(id) => tab.set(id)} accessibilityLabel={t("uig_fixture_choice")} /></Wide>
        <Text class="text-xs text-muted-foreground" testID="uig-tabs-echo">{t("uig_fixture_echo", { value: tab() })}</Text>
      </V>
      <V l="equal">
        <Tabs equal items={items()} value={tab()} onChange={(id) => tab.set(id)} />
      </V>
      <V l="narrow">
        <Wide><Tabs narrow items={items()} value={tab()} onChange={(id) => tab.set(id)} /></Wide>
      </V>
      <V l="iconOnly" row>
        <Tabs
          iconOnly
          items={[
            { id: "list", label: "List", icon: "PhListBullets" },
            { id: "grid", label: "Grid", icon: "PhSquaresFour" },
            { id: "calendar", label: "Calendar", icon: "PhCalendarBlank" },
          ]}
          value={icon()}
          onChange={(id) => icon.set(id)}
        />
      </V>
    </Col>
  );
}

function SectionDemo() {
  return (
    <Col>
      <Each of={["plain", "card", "head", "boxed", "pane"] as const} key={(variant) => variant}>
        {(variant) => (
          <V l={variant()}>
            <Section
              variant={variant()}
              title={t("uig_fixture_title")}
              meta={t("uig_fixture_count_many", { count: 12 })}
              actions={<Button variant="plain" size="xs" label={t("action_refresh")} onPress={() => act("Section", variant())} />}
            >
              <Muted>{LONG_TEXT}</Muted>
            </Section>
          </V>
        )}
      </Each>
      <V s="long" l="boxed · list · literal">
        <Section variant="boxed" list literal title={LONG_TEXT} meta={LONG_TEXT}>
          <View class="px-4 py-2"><Text class="text-sm text-foreground">{t("uig_fixture_option", { n: 1 })}</Text></View>
          <View class="px-4 py-2"><Text class="text-sm text-foreground">{t("uig_fixture_option", { n: 2 })}</Text></View>
        </Section>
      </V>
    </Col>
  );
}

function ProgressDemo() {
  const value = signal(35);
  return (
    <Col>
      <V s="default" l="value">
        <ProgressBar value={value()} label={t("uig_fixture_progress", { percent: value() })} />
        <View class="flex-row gap-2">
          <Button variant="outlined" size="xs" label="-15" onPress={() => value.update((v) => Math.max(0, v - 15))} />
          <Button variant="outlined" size="xs" label="+15" onPress={() => value.update((v) => Math.min(100, v + 15))} testID="uig-progress-more" />
          <Text class="text-xs text-muted-foreground" testID="uig-progress-echo">{t("uig_fixture_progress", { percent: value() })}</Text>
        </View>
      </V>
      <V s="loading" l="indeterminate">
        <ProgressBar indeterminate />
      </V>
      <Each of={TONES} key={(tone) => tone}>
        {(tone) => (
          <V l={`tone ${tone()}`}>
            <ProgressBar value={60} tone={tone()} />
          </V>
        )}
      </Each>
    </Col>
  );
}

export const CONTROL_DEMOS: DemoMap = {
  Button: { render: () => <ButtonDemo /> },
  CircleButton: { render: () => <CircleButtonDemo /> },
  TipButton: {
    render: () => (
      <Row>
        <V s="default" l="tooltip" row>
          <TipButton onPress={() => act("TipButton")} tooltip={<Tip text={t("uig_fixture_hint")} />} class="rounded-(--radius) border border-line px-3 py-2 hover:bg-hover">
            <Text class="text-sm text-foreground">{t("uig_fixture_hover")}</Text>
          </TipButton>
        </V>
        <V s="disabled" row>
          <TipButton disabled tooltip={<Tip text={t("uig_fixture_hint")} />} class="rounded-(--radius) border border-line px-3 py-2 opacity-50">
            <Text class="text-sm text-foreground">{t("uig_fixture_hover")}</Text>
          </TipButton>
        </V>
      </Row>
    ),
  },
  Tip: {
    render: () => (
      <Row>
        <Each of={["top", "bottom", "left", "right"] as const} key={(side) => side}>
          {(side) => (
            <V l={side()} row>
              <View class="rounded-(--radius) border border-line-faint px-3 py-2" tooltip={<Tip text={t("uig_fixture_hint")} placement={side()} />}>
                <Text class="text-sm text-foreground">{t("uig_fixture_hover")}</Text>
              </View>
            </V>
          )}
        </Each>
        <V l="shortcut" row>
          <View class="rounded-(--radius) border border-line-faint px-3 py-2" tooltip={<Tip text={t("uig_fixture_hint")} shortcut="⇧⌘O" />}>
            <Text class="text-sm text-foreground">{t("uig_fixture_hover")}</Text>
          </View>
        </V>
        <V s="long" row>
          <View class="rounded-(--radius) border border-line-faint px-3 py-2" tooltip={<Tip text={LONG_TEXT} />}>
            <Text class="text-sm text-foreground">{t("uig_fixture_hover")}</Text>
          </View>
        </V>
      </Row>
    ),
  },
  BusyBeam: {
    render: () => (
      <Row>
        <Each of={["primary", "outlined", "danger"] as const} key={(variant) => variant}>
          {(variant) => (
            <V s="busy" l={variant()}>
              <View class="relative h-9.5 w-32 items-center justify-center rounded-(--radius) border border-line-faint">
                <Text class="text-xs text-muted-foreground">{variant()}</Text>
                <BusyBeam busy variant={variant()} />
              </View>
            </V>
          )}
        </Each>
        <V s="off">
          <View class="relative h-9.5 w-32 items-center justify-center rounded-(--radius) border border-line-faint">
            <BusyBeam busy={false} />
          </View>
        </V>
      </Row>
    ),
  },
  TextField: { render: () => <TextFieldDemo />, wide: true },
  Toggle: { render: () => <ToggleDemo /> },
  CheckboxField: { render: () => <CheckboxDemo /> },
  SelectField: { render: () => <SelectDemo /> },
  DropdownMenu: { render: () => <MenuDemo /> },
  Tabs: { render: () => <TabsDemo /> },
  LanguageSelector: {
    render: () => (
      <V s="default" row>
        <LanguageSelector />
      </V>
    ),
  },
  Icon: {
    render: () => (
      <Row>
        <V l="size 12 / 16 / 20 / 28" row>
          <Icon name="PhChats" size={12} />
          <Icon name="PhChats" size={16} />
          <Icon name="PhChats" size={20} />
          <Icon name="PhChats" size={28} />
        </V>
        <V l="color" row>
          <Icon name="PhWarning" size={20} color="warn-dark" />
          <Icon name="PhWarningCircle" size={20} color="danger" />
          <Icon name="PhCheckCircle" size={20} color="ok" />
          <Icon name="PhInfo" size={20} color="blue" />
          <Icon name="PhGearSix" size={20} color="muted-foreground" />
        </V>
        <V l="filled" row>
          <Icon name="PhPushPin" size={20} />
          <Icon name="PhPushPin" size={20} filled />
        </V>
      </Row>
    ),
  },
  StatusMark: {
    render: () => (
      <Row>
        <Each of={STATUS_STATES} key={(state) => state}>
          {(state) => (
            <V l={state()} row>
              <StatusMark state={state()} />
              <StatusMark state={state()} size={12} corner={3} />
            </V>
          )}
        </Each>
      </Row>
    ),
  },
  Spinner: {
    render: () => (
      <V s="loading" l="size 12 / 16 / 24" row>
        <Spinner size={12} />
        <Spinner size={16} />
        <Spinner size={24} />
      </V>
    ),
  },
  Badge: {
    render: () => (
      <Row>
        <Each of={TONES} key={(tone) => tone}>
          {(tone) => (
            <V l={tone()} row>
              <Badge tone={tone()} label={t("uig_fixture_count_many", { count: 12 })} />
            </V>
          )}
        </Each>
        <V s="long" class="w-full">
          <Wide><Badge tone="info" label={LONG_TEXT} /></Wide>
        </V>
        <V l="children" row>
          <Badge tone="ok">
            <Icon name="PhCheck" size={11} color="ok" />
            <Text class="text-xs text-ok">{t("uig_fixture_count_one")}</Text>
          </Badge>
        </V>
      </Row>
    ),
  },
  Kicker: {
    render: () => (
      <Col>
        <V s="default">
          <Kicker>{t("uig_fixture_title")}</Kicker>
        </V>
        <V l="right">
          <Kicker right={<Badge tone="info" label="12" />}>{t("uig_fixture_title")}</Kicker>
        </V>
      </Col>
    ),
  },
  Heading: {
    render: () => (
      <Col>
        <V l="level 1"><Heading level={1}>{t("uig_fixture_title")}</Heading></V>
        <V l="level 2"><Heading level={2}>{t("uig_fixture_title")}</Heading></V>
        <V l="level 3"><Heading level={3}>{t("uig_fixture_title")}</Heading></V>
        <V s="long"><Heading level={2}>{LONG_TEXT}</Heading></V>
      </Col>
    ),
  },
  Muted: {
    render: () => (
      <Col>
        <V s="default"><Muted>{t("uig_fixture_hint")}</Muted></V>
        <V s="long" l="numberOfLines=2"><Muted numberOfLines={2}>{`${LONG_TEXT} ${LONG_TEXT}`}</Muted></V>
      </Col>
    ),
  },
  Markdown: {
    render: () => (
      <Col>
        <V s="default"><Markdown source={MARKDOWN} onLinkPress={acts("Markdown link")} /></V>
        <V s="loading" l="streaming"><Markdown source={"A reply that is still being wri"} streaming /></V>
        <V s="long"><Markdown source={`${LONG_TEXT}\n\n${LONG_WORD}`} selectable /></V>
      </Col>
    ),
    wide: true,
  },
  "Divider-components-ui": {
    render: () => (
      <Row>
        <V l="horizontal" class="w-48"><Divider /></V>
        <V l="vertical"><View class="h-10 flex-row"><Divider vertical /></View></V>
      </Row>
    ),
  },
  Card: {
    render: () => (
      <Row>
        <V s="default" class="w-64">
          <Card><Text class="text-sm text-foreground">{t("uig_fixture_hint")}</Text></Card>
        </V>
        <V l="onPress" class="w-64">
          <Card onPress={() => act("Card")} testID="uig-card-press"><Text class="text-sm text-foreground">{t("uig_fixture_press")}</Text></Card>
        </V>
        <V s="long" class="w-64">
          <Card><Text class="text-sm text-foreground">{LONG_TEXT}</Text><Text class="text-sm text-foreground">{LONG_WORD}</Text></Card>
        </V>
      </Row>
    ),
  },
  Section: { render: () => <SectionDemo />, wide: true },
  "Skeleton-components-ui": {
    render: () => (
      <Row>
        <V s="loading" l="rows=3" class="w-64"><Skeleton rows={3} label={t("msg_loading")} /></V>
        <V s="loading" l="rows=6" class="w-64"><Skeleton rows={6} /></V>
      </Row>
    ),
  },
  EmptyState: {
    render: () => (
      <Row>
        <V s="empty" class="w-72">
          <EmptyState title={t("uig_fixture_empty_title")} text={t("uig_fixture_empty_text")} icon="PhTray" />
        </V>
        <V s="empty" l="action" class="w-72">
          <EmptyState
            title={t("uig_fixture_empty_title")}
            text={LONG_TEXT}
            icon="PhMagnifyingGlass"
            action={<Button variant="outlined" size="xs" label={t("uig_fixture_reset")} onPress={() => act("EmptyState")} />}
          />
        </V>
      </Row>
    ),
  },
  LoadingLine: {
    render: () => (
      <Col>
        <V s="loading"><LoadingLine label={t("msg_loading")} /></V>
        <V s="loading" l="no label"><LoadingLine /></V>
      </Col>
    ),
  },
  ProgressBar: { render: () => <ProgressDemo /> },
  PageBar: {
    render: () => (
      <Col>
        <V s="default">
          <View class="border border-line-faint">
            <PageBar
              title={t("uig_fixture_title")}
              actions={<Button variant="outlined" size="sm" label={t("action_refresh")} onPress={() => act("PageBar")} />}
            />
          </View>
        </V>
        <V s="long" l="leading">
          <View class="border border-line-faint">
            <PageBar leading={<><BackButton title={t("uig_fixture_back")} onPress={() => act("BackButton")} /><PageTitle text={LONG_TEXT} /></>} />
          </View>
        </V>
      </Col>
    ),
    wide: true,
  },
  PageTitle: {
    render: () => (
      <Col>
        <V s="default"><View class="flex-row"><PageTitle text={t("uig_fixture_title")} /></View></V>
        <V s="long"><View class="flex-row"><PageTitle text={LONG_TEXT} /></View></V>
      </Col>
    ),
  },
  BackButton: {
    render: () => (
      <Row>
        <V s="default" row><BackButton title={t("uig_fixture_back")} onPress={() => act("BackButton")} testID="uig-back" /></V>
        <V l="desktopSize sm" row><BackButton title={t("uig_fixture_back")} desktopSize="sm" onPress={() => act("BackButton", "sm")} /></V>
      </Row>
    ),
  },
  Fab: {
    render: () => (
      <Row>
        <V s="default">
          <View class="relative h-24 w-40 border border-line-faint"><Fab label={t("uig_fixture_add")} icon="PhPlus" onPress={() => act("Fab")} testID="uig-fab" /></View>
        </V>
        <V s="disabled">
          <View class="relative h-24 w-40 border border-line-faint"><Fab label={t("uig_fixture_add")} disabled /></View>
        </V>
      </Row>
    ),
  },
};
