// Gallery demos: the motion components (components/motion) and the shared small parts
// (components/shared). Each animated demo has a control that plays it again.
import type { CanvasRenderingContext2D } from "nsh";
import { signal, Text, token, View } from "nsh";
import { BorderBeam } from "../../../components/motion/BorderBeam";
import { Entrance } from "../../../components/motion/Entrance";
import { FadeText } from "../../../components/motion/FadeText";
import { PixelResolve } from "../../../components/motion/PixelResolve";
import { sagHalf, SagRule } from "../../../components/motion/Sag";
import { EdgeScroll } from "../../../components/motion/ScrollEdges";
import { ContactAvatar } from "../../../components/shared/ContactAvatar";
import { CutoutAvatar } from "../../../components/shared/CutoutAvatar";
import { DateField } from "../../../components/shared/DateField";
import { MarkdownEditor } from "../../../components/shared/MarkdownEditor";
import { PickerList } from "../../../components/shared/PickerList";
import { PopoverPicker } from "../../../components/shared/PopoverPicker";
import { RawJsonDialog, RawJsonDialogContent } from "../../../components/shared/RawJsonDialog";
import { RollingNumber } from "../../../components/shared/RollingNumber";
import { Button, Icon, Muted } from "../../../components/ui";
import { act, Col, type DemoMap, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V } from "../demo";

const JSON_TEXT = JSON.stringify(
  { id: "evt_0001", kind: "tool_call", tool: "read_file", args: { path: "notes/2026-03-14.md", limit: 200 }, ok: true, tags: ["synthetic", "gallery"], note: LONG_TEXT },
  null,
  2,
);

const EDITOR_TEXT = ["# Notes", "", "A **synthetic** document for the gallery.", "", "- one", "- two", "", "```sh", "echo gallery", "```", "", LONG_TEXT].join("\n");

function pickerItems() {
  return [
    { value: "alpha", title: "Alpha", subtitle: "model/alpha-1", icon: <Icon name="PhCube" size={16} color="muted-foreground" /> },
    { value: "beta", title: "Beta", note: t("uig_fixture_hint") },
    { value: "gamma", title: "Gamma", disabled: true },
    { value: "long", title: LONG_TEXT, subtitle: LONG_WORD, separated: true },
    ...Array.from({ length: 12 }, (_, i) => ({ value: `n${i}`, title: t("uig_fixture_option", { n: i + 5 }) })),
  ];
}

function PickerListDemo() {
  const value = signal("beta");
  return (
    <Row>
      <V s="default" class="w-72">
        <View class="rounded-(--radius) border border-line-faint">
          <PickerList
            open
            items={pickerItems()}
            value={value()}
            onChoose={(next) => {
              value.set(next);
              act("PickerList", next);
            }}
            accessibilityLabel={t("uig_fixture_choice")}
            label={t("uig_fixture_choice")}
            filterPlaceholder={t("uig_filter_placeholder")}
            filterAutoFocus={false}
            emptyText={t("uig_fixture_empty_title")}
            maxHeight={260}
            part={(name) => `uig-pickerlist-${name}`}
          />
        </View>
      </V>
      <V s="empty" l="menu · footer" class="w-72">
        <View class="rounded-(--radius) border border-line-faint">
          <PickerList
            open
            role="menu"
            items={[]}
            onChoose={(next) => act("PickerList menu", next)}
            accessibilityLabel={t("uig_fixture_menu")}
            emptyText={t("uig_fixture_empty_title")}
            footer={[{ value: "delete", title: t("action_delete"), danger: true }]}
            maxHeight={200}
            part={(name) => `uig-pickerlist-menu-${name}`}
          />
        </View>
      </V>
    </Row>
  );
}

function PopoverPickerDemo() {
  const value = signal("alpha");
  const trigger = (label: string, testID?: string) => (state: { open: boolean }) => (
    <View class={`flex-row items-center gap-2 rounded-(--radius) border px-3 py-2 ${state.open ? "border-blue" : "border-line"}`} testID={testID}>
      <Text class="text-sm text-foreground">{label}</Text>
      <Icon name="PhCaretDown" size={12} color="muted-foreground" />
    </View>
  );
  return (
    <Row>
      <V s="default" row>
        <PopoverPicker
          items={pickerItems()}
          value={value()}
          onChange={(next) => {
            value.set(next);
            act("PopoverPicker", next);
          }}
          trigger={trigger(t("uig_fixture_choice"), "uig-popoverpicker-trigger")}
          accessibilityLabel={t("uig_fixture_choice")}
          label={t("uig_fixture_choice")}
          filterPlaceholder={t("uig_filter_placeholder")}
          emptyText={t("uig_fixture_empty_title")}
          partID="uig-popoverpicker"
        />
        <Text class="text-xs text-muted-foreground" testID="uig-popoverpicker-echo">{t("uig_fixture_echo", { value: value() })}</Text>
      </V>
      <V l="placement top · align end" row>
        <PopoverPicker items={pickerItems().slice(0, 3)} value={value()} onChange={(next) => value.set(next)} trigger={trigger("top")} accessibilityLabel="top" placement="top" align="end" />
      </V>
      <V s="disabled" row>
        <PopoverPicker disabled items={pickerItems()} value={value()} onChange={(next) => value.set(next)} trigger={trigger(t("uig_fixture_choice"))} accessibilityLabel={t("uig_fixture_choice")} />
      </V>
    </Row>
  );
}

function DateFieldDemo() {
  const day = signal<string | null>("2026-03-14");
  const moment = signal<string | null>("2026-03-14T09:30");
  const none = signal<string | null>(null);
  return (
    <Row>
      <V s="default" l="date" class="w-64">
        <DateField value={day()} onChange={({ value }) => day.set(typeof value === "string" ? value : null)} accessibilityLabel={t("uig_fixture_choice")} testID="uig-datefield" />
        <Text class="text-xs text-muted-foreground">{t("uig_fixture_echo", { value: day() ?? "" })}</Text>
      </V>
      <V l="timePrecision minute" class="w-64">
        <DateField value={moment()} timePrecision="minute" onChange={({ value }) => moment.set(typeof value === "string" ? value : null)} accessibilityLabel={t("uig_fixture_choice")} />
        <Text class="text-xs text-muted-foreground">{t("uig_fixture_echo", { value: moment() ?? "" })}</Text>
      </V>
      <V s="empty" class="w-64">
        <DateField value={none()} onChange={({ value }) => none.set(typeof value === "string" ? value : null)} accessibilityLabel={t("uig_fixture_choice")} />
      </V>
      <V s="disabled" class="w-64">
        <DateField value="2026-03-14" disabled accessibilityLabel={t("uig_fixture_choice")} />
      </V>
    </Row>
  );
}

function MarkdownEditorDemo() {
  const text = useText(EDITOR_TEXT);
  const empty = useText("");
  const plain = useText(EDITOR_TEXT);
  return (
    <Col>
      <V s="default" l="edit / preview">
        <MarkdownEditor value={text.get()} onChange={text.set} height={240} hint={t("uig_fixture_hint")} accessibilityLabel={t("uig_fixture_notes")} testID="uig-markdown-editor" />
      </V>
      <V s="default" l="plainText (a textarea, the TODO content)">
        <MarkdownEditor value={plain.get()} onChange={plain.set} height={160} plainText placeholder={t("uig_fixture_placeholder")} accessibilityLabel={t("uig_fixture_notes")} testID="uig-markdown-textarea" />
      </V>
      <Row>
        <V s="empty" class="min-w-64 flex-1">
          <MarkdownEditor value={empty.get()} onChange={empty.set} height={120} placeholder={t("uig_fixture_placeholder")} preview={false} accessibilityLabel={t("uig_fixture_notes")} />
        </V>
        <V s="readonly" class="min-w-64 flex-1">
          <MarkdownEditor value={EDITOR_TEXT} height={120} readOnly accessibilityLabel={t("uig_fixture_notes")} />
        </V>
        <V s="disabled" class="min-w-64 flex-1">
          <MarkdownEditor value={EDITOR_TEXT} height={120} disabled accessibilityLabel={t("uig_fixture_notes")} />
        </V>
      </Row>
    </Col>
  );
}

function RollingDemo() {
  const value = signal(1234.5);
  const text = () => `$${value().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <Row>
      <V s="default">
        <RollingNumber value={text()} class="text-3xl font-semibold text-foreground" testID="uig-rolling" />
        <View class="flex-row gap-2">
          <Button variant="outlined" size="xs" label="+987.65" onPress={() => value.update((v) => v + 987.65)} testID="uig-rolling-more" />
          <Button variant="plain" size="xs" label={t("uig_fixture_reset")} onPress={() => value.set(1234.5)} />
        </View>
      </V>
      <V l="text-xs">
        <RollingNumber value={`${Math.round(value())} tokens`} class="text-xs text-subtle" />
      </V>
    </Row>
  );
}

function SagDemo() {
  const at = signal(60);
  return (
    <Col>
      <V l="SagRule">
        <View class="relative h-10 w-72">
          <SagRule center={() => at()} half={sagHalf(48)} color={String(token("line"))} class="absolute bottom-0 left-0 right-0 h-[7px]" />
        </View>
        <View class="flex-row gap-2">
          <Button variant="outlined" size="xs" label="60" onPress={() => at.set(60)} />
          <Button variant="outlined" size="xs" label="150" onPress={() => at.set(150)} />
          <Button variant="outlined" size="xs" label="240" onPress={() => at.set(240)} />
        </View>
      </V>
    </Col>
  );
}

function ReplayDemo(props: { kind: "entrance" | "pixel" }) {
  const key = signal(1);
  return (
    <V s="default" l={props.kind === "entrance" ? "watch" : "watch · size 72"}>
      <If
        when={props.kind === "entrance"}
        else={
          <PixelResolve watch={key()} size={72}>
            <CutoutAvatar size={72} background={String(token("selection"))} paint={paintInitial(String(key()))} />
          </PixelResolve>
        }
      >
        <Entrance watch={key()} rise={12}>
          <View class="rounded-(--radius) border border-line-faint bg-card px-3 py-2">
            <Text class="text-sm text-foreground">{t("uig_fixture_option", { n: key() })}</Text>
          </View>
        </Entrance>
      </If>
      <Button variant="outlined" size="xs" label={t("uig_fixture_replay")} onPress={() => key.update((n) => n + 1)} testID={`uig-replay-${props.kind}`} />
    </V>
  );
}

function paintInitial(text: string) {
  return (cx: CanvasRenderingContext2D, size: number) => {
    cx.fillStyle = "#1b2a4a";
    cx.font = `600 ${Math.round(size * 0.42)}px sans-serif`;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(text.slice(0, 2).toUpperCase(), size / 2, size / 2);
  };
}

function RawJsonDemo() {
  const open = useFlag(false);
  return (
    <Col>
      <V l="RawJsonDialogContent">
        <RawJsonDialogContent json={JSON_TEXT} style={{ maxHeight: 180 }} />
      </V>
      <V l="RawJsonDialog" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set(true)} testID="uig-rawjson-open" />
        <RawJsonDialog open={open.on()} json={JSON_TEXT} onClose={() => open.set(false)} testID="uig-rawjson" />
      </V>
    </Col>
  );
}

export const MOTION_DEMOS: DemoMap = {
  BorderBeam: {
    render: () => (
      <Row>
        <Each of={[40, 64, 120]} key={(length) => String(length)}>
          {(length) => (
            <V l={`length ${length()}`}>
              <View class="relative h-12 w-40 rounded-(--radius) border border-line-faint">
                <BorderBeam length={length()} />
              </View>
            </V>
          )}
        </Each>
        <V l="radius 24">
          <View class="relative size-12 rounded-full border border-line-faint">
            <BorderBeam length={40} radius={24} />
          </View>
        </V>
      </Row>
    ),
  },
  Entrance: { render: () => <ReplayDemo kind="entrance" /> },
  PixelResolve: { render: () => <ReplayDemo kind="pixel" /> },
  FadeText: {
    render: () => (
      <Col>
        <V s="default"><View class="w-64 flex-row"><FadeText text={t("uig_fixture_title")} class="flex-1 text-sm text-foreground" /></View></V>
        <V s="long" l="w-64"><View class="w-64 flex-row"><FadeText text={LONG_TEXT} class="flex-1 text-sm text-foreground" /></View></V>
        <V s="long" l="noTooltip · fade 80"><View class="w-64 flex-row"><FadeText text={LONG_WORD} noTooltip fade={80} class="flex-1 font-mono text-xs text-subtle" /></View></V>
      </Col>
    ),
  },
  SagRule: { render: () => <SagDemo /> },
  EdgeScroll: {
    render: () => (
      <Row>
        <V s="long" l="vertical" class="w-64">
          <EdgeScroll class="h-32 rounded-(--radius) border border-line-faint" contentClass="gap-2 p-3">
            <Each of={Array.from({ length: 8 }, (_, i) => i)}>{() => <Muted>{LONG_TEXT}</Muted>}</Each>
          </EdgeScroll>
        </V>
        <V s="long" l="horizontal" class="w-64">
          <EdgeScroll horizontal class="rounded-(--radius) border border-line-faint" contentClass="flex-row gap-2 p-3">
            <Each of={Array.from({ length: 14 }, (_, i) => i + 1)}>
              {(n) => (
                <View class="rounded-(--radius) bg-muted px-3 py-2"><Text class="text-sm text-foreground">{t("uig_fixture_option", { n: n() })}</Text></View>
              )}
            </Each>
          </EdgeScroll>
        </V>
      </Row>
    ),
  },
  ContactAvatar: {
    render: () => (
      <Row>
        <V l="list / detail / 96" row>
          <ContactAvatar item={null} name="Ada Lovelace" endpointRef="" size="list" />
          <ContactAvatar item={null} name="林黛玉" endpointRef="" size="detail" />
          <ContactAvatar item={null} name="夏目漱石" endpointRef="" size={96} />
        </V>
        <V l="notch" row>
          <ContactAvatar item={null} name="Grace Hopper" endpointRef="" size="detail" notch={{ x: 54, y: 54, r: 12 }} />
        </V>
        <V s="empty" row>
          <ContactAvatar item={null} endpointRef="" size="detail" />
        </V>
      </Row>
    ),
  },
  CutoutAvatar: {
    render: () => (
      <Row>
        <V l="paint" row>
          <CutoutAvatar size={40} background={String(token("selection"))} paint={paintInitial("AB")} />
          <CutoutAvatar size={64} background={String(token("selection"))} paint={paintInitial("墨")} />
        </V>
        <V l="notch" row>
          <CutoutAvatar size={64} background={String(token("selection"))} paint={paintInitial("N")} notch={{ x: 54, y: 54, r: 12 }} />
        </V>
        <V s="empty" row>
          <CutoutAvatar size={64} background={String(token("muted"))} />
        </V>
      </Row>
    ),
  },
  DateField: { render: () => <DateFieldDemo /> },
  MarkdownEditor: { render: () => <MarkdownEditorDemo />, wide: true },
  PickerList: { render: () => <PickerListDemo /> },
  PopoverPicker: { render: () => <PopoverPickerDemo /> },
  RawJsonDialog: { render: () => <RawJsonDemo /> },
  RollingNumber: { render: () => <RollingDemo /> },
};
