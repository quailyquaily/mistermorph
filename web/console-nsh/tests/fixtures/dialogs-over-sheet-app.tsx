// A test entry for tests/dialogs-over-sidebar.test.tsx: the right sidebar of a phone (the chat's
// `WorkspaceSheet`, or a `SidePane` sheet) or of a wide window (a `SidePane` column), with buttons
// that open the console's dialogs (a Modal, a MessageDialog), declared on the page beside the
// sidebar as ChatPage declares its rename dialog.
// The sheet's body is plain paper (no view of it hears presses), so a press the sheet's paper takes
// instead of the dialog's fails the step ("is covered"). The line of text says what happened:
// which sheet is open, its count, what closed the dialogs and the sheet.
import { mount, signal, Text, View } from "nsh";
import { Button, MessageDialog, Modal, SidePane } from "../../components/ui";
import { WorkspaceSheet } from "../../pages/chat/WorkspacePanel";

const sheet = signal<"workspace" | "side" | "column" | null>(null);
const dialog = signal<"modal" | "message" | null>(null);
const count = signal(0);
const events = signal<string[]>([]);
const log = (event: string) => events.update((list) => [...list, event]);

function SheetBody() {
  return (
    <View class="flex-1 gap-2 p-4" testID="sheet-body">
      <Text class="text-sm">{`count=${count()}`}</Text>
      <Button size="sm" label="Bump" onPress={() => count.set(count() + 1)} testID="sheet-bump" />
      <Button size="sm" label="Open a dialog" onPress={() => dialog.set("modal")} testID="sheet-open-modal" />
      <Button size="sm" label="Open a message" onPress={() => dialog.set("message")} testID="sheet-open-message" />
      {/* Plain paper down to the sheet's foot: under every phone dialog's paper. */}
      <View class="flex-1" testID="sheet-paper" />
    </View>
  );
}

function Page() {
  const closeSheet = (name: string) => {
    log(`sheet closed (${name})`);
    sheet.set(null);
  };
  const closeDialog = (how: string) => {
    log(`dialog closed (${how})`);
    dialog.set(null);
  };
  return (
    <View class="flex-1 gap-2 bg-paper p-2 pt-12">
      <View class="flex-row gap-2">
        <Button size="xs" label="workspace sheet" onPress={() => sheet.set("workspace")} testID="open-workspace-sheet" />
        <Button size="xs" label="side pane" onPress={() => sheet.set("side")} testID="open-side-pane" />
        <Button size="xs" label="side column" onPress={() => sheet.set("column")} testID="open-side-column" />
      </View>
      <Text class="text-xs" testID="state">{`sheet=${sheet() ?? "none"} dialog=${dialog() ?? "none"} | ${events().join(", ")}`}</Text>

      <WorkspaceSheet open={sheet() === "workspace"} onClose={() => closeSheet("workspace")}>
        <SheetBody />
      </WorkspaceSheet>
      <SidePane open={sheet() === "side"} onClose={() => closeSheet("side")} sheet label="Side pane">
        <SheetBody />
      </SidePane>
      {/* A wide window's sidebar: a column at the right of the content. */}
      <View class="flex-1 flex-row">
        <View class="flex-1" />
        <SidePane open={sheet() === "column"} onClose={() => closeSheet("column")} label="Side column">
          <SheetBody />
        </SidePane>
      </View>

      <Modal
        open={dialog() === "modal"}
        onClose={() => closeDialog("modal")}
        title="A dialog over the sidebar"
        testID="over-modal"
        footer={<Button variant="primary" label="Done" onPress={() => closeDialog("done")} testID="over-modal-done" />}
      >
        {/* As wide as the paper: its middle is over the sheet's paper. */}
        <Button label="Inside the dialog" onPress={() => log("dialog pressed")} testID="over-modal-inside" block />
      </Modal>
      <MessageDialog
        open={dialog() === "message"}
        onClose={() => closeDialog("message")}
        icon="PhTrash"
        tone="danger"
        title="A message over the sidebar"
        text="Its choices take the presses."
        testID="over-message"
        actions={[{ id: "ok", label: "Understood", variant: "primary", onPress: () => closeDialog("ok") }]}
      />
    </View>
  );
}

mount(() => <Page />);
