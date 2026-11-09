// A test entry for tests/workspace-sheet.test.tsx: the chat's topic and workspace panel as the phone
// sheet draws it (WorkspaceSheet, the phone tab row) inside a frame padded as the app's is
// (App.tsx: `systemInsets()`), and the wide window's tab row beside it, with the frames they lay
// out at read out as text. `pagePosition` is where a view is on the surface.
import type { Bounds } from "nsh";
import { mount, signal, Text, View } from "nsh";
import { systemInsets } from "../../lib/shell";
import { WorkspacePanelTabs, WorkspaceSheet } from "../../pages/chat/WorkspacePanel";

type Frame = { x: number; y: number; w: number; h: number; px?: number; py?: number };

const TABS = [
  { id: "topic", label: "Topic" },
  { id: "workspace", label: "Workspace" },
];

const frames = signal<Record<string, Frame>>({});
const sheetOpen = signal(true);
const phoneTab = signal("topic");
const wideTab = signal("topic");
const presses = signal(0);

function put(name: string, frame: Frame) {
  frames.update((all) => ({ ...all, [name]: { ...all[name], ...frame } }));
}

function track(name: string) {
  return (event: { bounds: Bounds }) => {
    const { origin, size } = event.bounds;
    put(name, { x: origin.x, y: origin.y, w: size.width, h: size.height });
  };
}

/** A view whose frame and place on the surface are read out as `name`. */
function Measured(props: { name: string; class?: string; children?: any }) {
  let node: any = null;
  return (
    <View
      class={props.class ?? ""}
      testID={props.name}
      ref={(ref: any) => (node = ref)}
      onLayout={(event: { bounds: Bounds }) => {
        track(props.name)(event);
        void node?.measure().then((m: any) => {
          if (m) put(props.name, { ...frames()[props.name], px: m.pagePosition.x, py: m.pagePosition.y });
        });
      }}
    >
      {props.children}
    </View>
  );
}

function frameStyle() {
  const insets = systemInsets();
  if (!insets) return undefined;
  const { top, right, bottom, left } = insets.frame;
  return { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left };
}

function Gallery() {
  return (
    <View class="flex-1 bg-background" style={frameStyle()}>
      <Measured name="page" class="flex-1">
        {/* The wide window's panel row, 314pt wide with its toggle's 38pt box at the right. */}
        <View class="w-[314px] bg-card">
          <Measured name="wide-row">
            <WorkspacePanelTabs
              tabs={TABS}
              value={wideTab()}
              onChange={(id) => wideTab.set(id)}
              onTabLayout={(id, event) => track(`wide-tab-${id}`)(event)}
              trailing={<View class="size-[38px] border border-line-soft" />}
            />
          </Measured>
        </View>
        <View class="flex-row gap-2 p-2">
          <Text testID="sheet-open-button" onPress={() => sheetOpen.set(true)}>
            Open
          </Text>
          <Text testID="state">{`open=${sheetOpen()} tab=${phoneTab()} presses=${presses()}`}</Text>
        </View>
        <Text>{JSON.stringify(frames())}</Text>
      </Measured>
      <WorkspaceSheet open={sheetOpen()} onClose={() => sheetOpen.set(false)}>
        <Measured name="sheet-body" class="flex-1">
          <Measured name="phone-row">
            <WorkspacePanelTabs
              phone
              tabs={TABS}
              value={phoneTab()}
              onChange={(id) => {
                presses.update((n) => n + 1);
                phoneTab.set(id);
              }}
              onTabLayout={(id, event) => track(`phone-tab-${id}`)(event)}
            />
          </Measured>
          <Text testID="sheet-content">{phoneTab() === "topic" ? "Topic body" : "Workspace body"}</Text>
        </Measured>
      </WorkspaceSheet>
    </View>
  );
}

mount(() => <Gallery />);
