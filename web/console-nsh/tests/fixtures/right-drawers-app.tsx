// A test entry for tests/right-drawer-insets.test.tsx: the phone's drawers from the right (a
// `SidePane` sheet as Settings, the channels and Audit open it, the skill store's `SkillStoreSheet`,
// the chat's `WorkspaceSheet`) and a wide window's `SidePane` column, inside a frame padded as the
// app's is (App.tsx: `systemInsets()`), each with a head, a scrolling body and a foot as their
// users lay them out. The frames they lay out at are read out as text; `px`/`py` is where a view
// is on the surface. All three sheets are open at once (the newest on top): each foot's button
// closes its own.
import type { Bounds } from "nsh";
import { mount, Scroll, signal, Text, View } from "nsh";
import { Button, SidePane } from "../../components/ui";
import { systemInsets } from "../../lib/shell";
import { WorkspaceSheet } from "../../pages/chat/WorkspacePanel";
import { SkillStoreSheet } from "../../pages/skills/SkillStorePage";

type Frame = { x: number; y: number; w: number; h: number; px?: number; py?: number };

const frames = signal<Record<string, Frame>>({});
const open = signal<Record<string, boolean>>({ side: true, store: true, workspace: true });
const closed = signal<string[]>([]);

function put(name: string, frame: Partial<Frame>) {
  frames.update((all) => ({ ...all, [name]: { ...all[name], ...frame } as Frame }));
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
        const { origin, size } = event.bounds;
        put(props.name, { x: origin.x, y: origin.y, w: size.width, h: size.height });
        void node?.measure().then((m: any) => {
          if (m) put(props.name, { px: m.pagePosition.x, py: m.pagePosition.y });
        });
      }}
    >
      {props.children}
    </View>
  );
}

/** A drawer's content as a pane lays it out: a head, a body that scrolls, a foot with its action. */
function Body(props: { name: string }) {
  const close = () => {
    closed.update((list) => [...list, props.name]);
    open.update((all) => ({ ...all, [props.name]: false }));
  };
  return (
    <Measured name={`${props.name}-body`} class="flex-1">
      <Measured name={`${props.name}-head`} class="h-[57px] flex-row items-center border-b border-line px-4">
        <Text class="text-sm">{`${props.name} head`}</Text>
      </Measured>
      <Measured name={`${props.name}-scroll`} class="flex-1">
        <Scroll class="flex-1">
          <View class="h-[1600px] p-4">
            <Text class="text-sm">{`${props.name} content`}</Text>
          </View>
        </Scroll>
      </Measured>
      <Measured name={`${props.name}-foot`} class="h-14 flex-row items-center border-t border-line px-4">
        <Button size="sm" label={`Close ${props.name}`} onPress={close} testID={`${props.name}-close`} />
      </Measured>
    </Measured>
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
    <View class="flex-1 bg-paper" style={frameStyle()}>
      <Measured name="page" class="flex-1">
        <Text testID="state">{`closed=${closed().join(",") || "none"}`}</Text>
        <Text>{JSON.stringify(frames())}</Text>
        {/* A wide window's pane: a column at the right of the content, inside the frame. */}
        <View class="flex-1 flex-row">
          <View class="flex-1" />
          <SidePane open onClose={() => {}} label="Column pane" class="w-40">
            <Body name="column" />
          </SidePane>
        </View>
      </Measured>
      <WorkspaceSheet open={open().workspace} onClose={() => open.update((all) => ({ ...all, workspace: false }))}>
        <Body name="workspace" />
      </WorkspaceSheet>
      <SidePane sheet open={open().side} onClose={() => open.update((all) => ({ ...all, side: false }))} label="Side pane">
        <Body name="side" />
      </SidePane>
      <SkillStoreSheet open={open().store} onClose={() => open.update((all) => ({ ...all, store: false }))}>
        <Body name="store" />
      </SkillStoreSheet>
    </View>
  );
}

mount(() => <Gallery />);
