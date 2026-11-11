// A test entry for tests/dialog-sheet.test.tsx: the console's dialogs (Modal, MessageDialog,
// SettingDialog), each opened by a button on the page, with what the test reads of them put
// beside it as JSON: the panel's frame in its layer (`<kind>.panel`), the footer row's frame on
// the surface (`<kind>.footer`), each footer button's width (`<kind>.b<n>`), and, after each
// opening and closing, the panel's motion sampled every frame for 600 ms with whether the
// dialog's body was still mounted (`<kind>.in<n>`, `<kind>.out<n>`).
import { cleanup, effect, mount, signal, Text, untracked, View, type Motion, type ViewRef } from "nsh";
import { Button, MessageDialog, Modal, type DialogProbe } from "../../components/ui";
import { SettingDialog } from "../../components/settings/SettingDialog";

const KINDS = ["two", "three", "one", "toggle", "bare", "long", "message2", "message3", "setting"] as const;
type Kind = (typeof KINDS)[number];

const which = signal<Kind | null>(null);
const third = signal(true);
const report = signal<Record<string, unknown>>({});
const put = (key: string, value: unknown) => report.update((all) => ({ ...all, [key]: value }));

const motions: Partial<Record<Kind, Motion>> = {};
const alive: Partial<Record<Kind, boolean>> = {};
const openings: Partial<Record<Kind, number>> = {};
const round = (n: number) => Math.round(n * 1000) / 1000;

function probe(kind: Kind): DialogProbe {
  return {
    motion: (motion) => {
      motions[kind] = motion;
    },
    layout: (bounds) =>
      put(`${kind}.panel`, { y: round(bounds.origin.y), h: round(bounds.size.height), w: round(bounds.size.width) }),
  };
}

// The panel's motion every frame for 600 ms after it was asked to open or close.
function sample(kind: Kind, label: string) {
  const series: { t: number; y: number; s: number; o: number; alive: boolean }[] = [];
  const started = Date.now();
  const tick = async () => {
    const motion = motions[kind];
    if (motion) {
      const [y, s, o] = await Promise.all([motion.translateY.getValue(), motion.scale.getValue(), motion.opacity.getValue()]);
      series.push({ t: Date.now() - started, y: round(y), s: round(s), o: round(o), alive: !!alive[kind] });
    }
    if (Date.now() - started < 600) setTimeout(() => void tick(), 16);
    else put(label, series);
  };
  void tick();
}

let previous: Kind | null = null;
effect(() => {
  const now = which();
  untracked(() => {
    if (previous && previous !== now) sample(previous, `${previous}.out${openings[previous]}`);
    if (now) {
      openings[now] = (openings[now] ?? 0) + 1;
      sample(now, `${now}.in${openings[now]}`);
    }
    previous = now;
  });
});

/** The dialog's body: marks it mounted while it is. */
function Body(props: { kind: Kind; rows?: number }) {
  alive[props.kind] = true;
  cleanup(() => {
    alive[props.kind] = false;
  });
  return (
    <View class="gap-2" testID={`body-${props.kind}`}>
      <Text class="text-sm">{`The ${props.kind} dialog.`}</Text>
      <Each of={Array.from({ length: props.rows ?? 0 }, (_, i) => i)} key={(i) => i}>
        {(i) => (
          <Text class="h-10 text-sm" testID={`row-${i()}`}>
            {`Row ${i()}`}
          </Text>
        )}
      </Each>
    </View>
  );
}

/** The footer row's frame on the surface (an absolute view over it: no button, so it is not counted). */
function FooterFrame(props: { kind: Kind }) {
  let node: ViewRef | undefined;
  return (
    <View
      ref={(n) => {
        node = n;
      }}
      class="absolute inset-0"
      style={{ pointerEvents: "none" }}
      onLayout={() =>
        void node?.measure().then((m) => {
          if (m) put(`${props.kind}.footer`, { y: round(m.pagePosition.y), h: round(m.bounds.size.height), w: round(m.bounds.size.width) });
        })
      }
    />
  );
}

function action(kind: Kind, n: number, label: string, variant: "outlined" | "primary" | "danger" = "outlined") {
  return (
    <Button
      variant={variant}
      label={label}
      onPress={() => which.set(null)}
      onLayout={(event) => put(`${kind}.b${n}`, round(event.bounds.size.width))}
      testID={`${kind}-action-${n}`}
    />
  );
}

function Page() {
  const close = () => which.set(null);
  return (
    <View class="flex-1 gap-1 bg-background p-2">
      <View class="flex-row flex-wrap gap-1">
        <Each of={[...KINDS]} key={(kind) => kind}>
          {(kind) => <Button size="xs" label={`open ${kind()}`} onPress={() => which.set(kind())} testID={`open-${kind()}`} />}
        </Each>
        <Button size="xs" label="toggle third" onPress={() => third.set(!third())} testID="toggle-third" />
        {/* Closes whichever is open, as its owner would (headless presses do no hit test). */}
        <Button size="xs" label="close" onPress={close} testID="close-all" />
        {/* Closes the two-action dialog and opens it again while it is still going out. */}
        <Button
          size="xs"
          label="bounce"
          onPress={() => {
            which.set(null);
            setTimeout(() => which.set("two"), 90);
          }}
          testID="bounce-two"
        />
      </View>
      <Text class="text-[6px]">{JSON.stringify(report())}</Text>

      <Modal
        open={which() === "two"}
        onClose={close}
        title="Two actions"
        testID="dialog-two"
        probe={probe("two")}
        footer={
          <>
            <FooterFrame kind="two" />
            {action("two", 0, "Cancel")}
            {action("two", 1, "Remove this agent for good", "danger")}
          </>
        }
      >
        <Body kind="two" />
      </Modal>
      <Modal
        open={which() === "three"}
        onClose={close}
        title="Three actions"
        testID="dialog-three"
        probe={probe("three")}
        footer={
          <>
            {action("three", 0, "Cancel")}
            {action("three", 1, "Later")}
            {action("three", 2, "Remove this agent", "danger")}
          </>
        }
      >
        <Body kind="three" />
      </Modal>
      <Modal
        open={which() === "one"}
        onClose={close}
        title="One action"
        testID="dialog-one"
        probe={probe("one")}
        footer={action("one", 0, "Save", "primary")}
      >
        <Body kind="one" />
      </Modal>
      <Modal
        open={which() === "toggle"}
        onClose={close}
        title="A third action that comes and goes"
        testID="dialog-toggle"
        probe={probe("toggle")}
        footer={
          <>
            {action("toggle", 0, "Cancel")}
            <If when={third()}>{action("toggle", 2, "Retry")}</If>
            {action("toggle", 1, "Save changes", "primary")}
          </>
        }
      >
        <Body kind="toggle" />
      </Modal>
      <Modal open={which() === "bare"} onClose={close} title="No body, no footer" testID="dialog-bare" probe={probe("bare")} />
      <Modal
        open={which() === "long"}
        onClose={close}
        title="A long body"
        testID="dialog-long"
        probe={probe("long")}
        footer={
          <>
            <FooterFrame kind="long" />
            {action("long", 0, "Cancel")}
            {action("long", 1, "Save", "primary")}
          </>
        }
      >
        <Body kind="long" rows={40} />
      </Modal>
      <MessageDialog
        open={which() === "message2"}
        onClose={close}
        title="Two choices"
        text="A message with two choices."
        testID="dialog-message2"
        probe={probe("message2")}
        actions={[
          { id: "cancel", label: "Cancel", onPress: close },
          { id: "ok", label: "Remove this agent for good", variant: "danger", onPress: close },
        ]}
      >
        <Body kind="message2" />
      </MessageDialog>
      <MessageDialog
        open={which() === "message3"}
        onClose={close}
        title="Three choices"
        testID="dialog-message3"
        probe={probe("message3")}
        actions={[
          { id: "a", label: "Cancel", onPress: close },
          { id: "b", label: "Later", onPress: close },
          { id: "c", label: "Remove this agent", variant: "danger", onPress: close },
        ]}
      >
        <Body kind="message3" />
      </MessageDialog>
      <SettingDialog
        open={which() === "setting"}
        onOpenChange={(open) => !open && close()}
        onSave={close}
        title="A setting"
        testID="dialog-setting"
        probe={probe("setting")}
      >
        <Body kind="setting" />
      </SettingDialog>
    </View>
  );
}

mount(() => <Page />);
