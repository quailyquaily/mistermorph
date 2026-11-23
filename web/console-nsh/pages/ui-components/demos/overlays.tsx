// Gallery demos: dialogs, sheets, popups, notices and the page frame parts of components/ui.tsx.
// Every overlay opens from a button in its card and closes with its own controls; nothing is open
// when the page loads.
import { signal, Text, View } from "nsh";
import { dismissNotice, NOTICE_TYPES, pushNotice } from "../../../lib/core/notices.js";
import {
  Button,
  DialogActions,
  DialogLayer,
  MessageDialog,
  Modal,
  Muted,
  Page,
  SidePane,
  TextField,
} from "../../../components/ui";
import { act, Col, type DemoMap, LONG_TEXT, Row, t, useFlag, useText, V } from "../demo";

function ModalDemo() {
  const open = signal<"" | "sm" | "md" | "lg" | "xl" | "full" | "long">("");
  const name = useText("Morph");
  const close = () => open.set("");
  return (
    <Row>
      <Each of={["sm", "md", "lg", "xl", "full"] as const} key={(size) => size}>
        {(size) => (
          <V l={`size ${size()}`} row>
            <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set(size())} testID={`uig-modal-open-${size()}`} />
          </V>
        )}
      </Each>
      <V s="long" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set("long")} testID="uig-modal-open-long" />
      </V>
      <Modal
        open={open() !== ""}
        onClose={close}
        size={open() === "long" || open() === "" ? "md" : (open() as "sm")}
        title={open() === "long" ? LONG_TEXT : t("uig_fixture_title")}
        description={open() === "long" ? LONG_TEXT : t("uig_fixture_hint")}
        closeLabel={t("action_close")}
        testID="uig-modal"
        footer={
          <>
            <Button variant="outlined" label={t("action_cancel")} onPress={close} testID="uig-modal-cancel" />
            <Button
              label={t("action_save")}
              onPress={() => {
                act("Modal", "save");
                close();
              }}
              testID="uig-modal-save"
            />
          </>
        }
      >
        <View class="gap-3 p-4">
          <Muted>{t("uig_fixture_dialog_text")}</Muted>
          <TextField label={t("uig_fixture_name")} value={name.get()} onChange={name.set} />
          <If when={open() === "long"}>
            <Each of={Array.from({ length: 14 }, (_, i) => i)}>{() => <Muted>{LONG_TEXT}</Muted>}</Each>
          </If>
        </View>
      </Modal>
    </Row>
  );
}

function MessageDialogDemo() {
  const open = signal<"" | "neutral" | "info" | "ok" | "warn" | "danger" | "busy">("");
  const close = () => open.set("");
  return (
    <Row>
      <Each of={["neutral", "info", "ok", "warn", "danger"] as const} key={(tone) => tone}>
        {(tone) => (
          <V l={`tone ${tone()}`} row>
            <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set(tone())} testID={`uig-message-open-${tone()}`} />
          </V>
        )}
      </Each>
      <V s="busy" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set("busy")} />
      </V>
      <MessageDialog
        open={open() !== ""}
        onClose={close}
        title={t("uig_fixture_title")}
        text={open() === "danger" ? LONG_TEXT : t("uig_fixture_dialog_text")}
        icon={open() === "danger" ? "PhWarning" : open() === "ok" ? "PhCheckCircle" : "PhInfo"}
        tone={open() === "busy" || open() === "" ? "neutral" : (open() as "info")}
        testID="uig-message"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: close },
          {
            id: "ok",
            label: open() === "danger" ? t("action_delete") : t("action_save"),
            variant: open() === "danger" ? "danger" : "primary",
            loading: open() === "busy",
            onPress: () => {
              act("MessageDialog", open());
              close();
            },
          },
        ]}
      />
    </Row>
  );
}

function NoticeDemo() {
  const ids = signal<string[]>([]);
  const push = (type: string, long = false) => {
    const id = `uig-notice-${type}${long ? "-long" : ""}`;
    pushNotice({ id, type, text: long ? LONG_TEXT : t("uig_fixture_notice", { type }), timeout: 0 });
    ids.update((all) => (all.includes(id) ? all : [...all, id]));
    act("pushNotice", type);
  };
  const clear = () => {
    for (const id of ids()) dismissNotice(id);
    ids.set([]);
  };
  return (
    <Row>
      <Each of={NOTICE_TYPES as string[]} key={(type) => type}>
        {(type) => (
          <V l={type()} row>
            <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => push(type())} testID={`uig-notice-${type()}`} />
          </V>
        )}
      </Each>
      <V s="long" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => push("warning", true)} />
      </V>
      <V l="dismiss" row>
        <Button variant="plain" label={t("uig_fixture_reset")} onPress={clear} testID="uig-notice-clear" />
      </V>
    </Row>
  );
}

function DialogLayerDemo() {
  const open = signal<"" | "dialog" | "sheet">("");
  const close = () => open.set("");
  return (
    <Row>
      <V s="default" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set("dialog")} testID="uig-dialoglayer-open" />
      </V>
      <V l="sheet" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => open.set("sheet")} />
      </V>
      <DialogLayer open={open() !== ""} onClose={close} sheet={open() === "sheet"} label={t("uig_fixture_title")} panelClass="w-full max-w-[420px]" testID="uig-dialoglayer">
        <View class="gap-2 p-4">
          <Text class="text-base font-semibold text-foreground" role="header">{t("uig_fixture_title")}</Text>
          <Muted>{t("uig_fixture_dialog_text")}</Muted>
        </View>
        <DialogActions class="flex-row items-center justify-end gap-3 border-t border-line px-4 py-2">
          <Button variant="outlined" label={t("action_cancel")} onPress={close} testID="uig-dialoglayer-cancel" />
          <Button
            label={t("action_save")}
            onPress={() => {
              act("DialogLayer", "save");
              close();
            }}
          />
        </DialogActions>
      </DialogLayer>
    </Row>
  );
}

function SidePaneDemo() {
  const column = useFlag(true);
  const sheet = useFlag(false);
  return (
    <Col>
      <V l="column" class="self-stretch">
        <Button variant="outlined" size="xs" label={column.on() ? t("action_close") : t("uig_fixture_open")} onPress={column.toggle} testID="uig-sidepane-toggle" />
        <View class="h-48 flex-row overflow-hidden rounded-(--radius) border border-line-faint">
          <View class="min-w-0 flex-1 p-3"><Muted>{LONG_TEXT}</Muted></View>
          <SidePane open={column.on()} onClose={() => column.set(false)} label={t("uig_fixture_title")} class="w-56">
            <View class="gap-2 p-3" testID="uig-sidepane-body">
              <Text class="text-sm font-medium text-foreground">{t("uig_fixture_title")}</Text>
              <Muted>{t("uig_fixture_hint")}</Muted>
            </View>
          </SidePane>
        </View>
      </V>
      <V l="sheet" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => sheet.set(true)} />
        <SidePane open={sheet.on()} onClose={() => sheet.set(false)} sheet label={t("uig_fixture_title")}>
          <View class="gap-3 p-4">
            <Text class="text-base font-medium text-foreground">{t("uig_fixture_title")}</Text>
            <Muted>{t("uig_fixture_dialog_text")}</Muted>
            <Button variant="outlined" label={t("action_close")} onPress={() => sheet.set(false)} />
          </View>
        </SidePane>
      </V>
    </Col>
  );
}

export const OVERLAY_DEMOS: DemoMap = {
  Modal: { render: () => <ModalDemo /> },
  MessageDialog: { render: () => <MessageDialogDemo /> },
  NoticeHost: { render: () => <NoticeDemo /> },
  DialogLayer: { render: () => <DialogLayerDemo /> },
  SidePane: { render: () => <SidePaneDemo /> },
  Page: {
    render: () => (
      <Col>
        <V s="default" l="scroll">
          <View class="h-56 overflow-hidden rounded-(--radius) border border-line-faint">
            <Page title={t("uig_fixture_title")} actions={<Button variant="outlined" size="sm" label={t("action_save")} onPress={() => act("Page", "refresh")} />}>
              <Muted>{LONG_TEXT}</Muted>
              <Muted>{LONG_TEXT}</Muted>
              <Muted>{LONG_TEXT}</Muted>
              <Muted>{LONG_TEXT}</Muted>
            </Page>
          </View>
        </V>
        <V l="hideBar">
          <View class="h-24 overflow-hidden rounded-(--radius) border border-line-faint">
            <Page hideBar><Muted>{t("uig_fixture_hint")}</Muted></Page>
          </View>
        </V>
      </Col>
    ),
    wide: true,
  },
};
