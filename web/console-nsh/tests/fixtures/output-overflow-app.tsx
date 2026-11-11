// A test entry for tests/chat-output-overflow.test.tsx: the detail panel (ActivityDetailPanel) as
// wide as the window, showing a reply's progress or one of its coders, with runs that do not wrap
// (a long command, a multiline script parameter, a long tool name, nested calls, a long process)
// beside output, notes and errors that wrap. Every such run's line (OverflowLine) reports its
// widths, whether it scrolls and its offset; they and the panel's width are read out below it as
// JSON. The buttons switch what the panel shows, the empty states included.
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../components/ui";
import type { ActivityDetailRef } from "../../components/chat/activityDetail";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { probeOverflowLines, type OverflowLineFrame } from "../../components/chat/OverflowLine";
import { ActivityDetailPanel } from "../../pages/chat/ActivityDetailPanel";
import { normalizeActivity } from "../../lib/core/chat-task-history.js";

const PATH = "/home/user/projects/very/long/path/to/some/deeply/nested/module/that/never/ends/file_name.go:1234:56";
const OUTPUT = `${PATH}\nNAME        READY   STATUS    RESTARTS   AGE\napi-7f9c8d  1/1     Running   0          3d4h\nThis sentence of prose keeps wrapping inside the panel.`;
const activity = normalizeActivity({
  history: [
    { id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: `ls -la ${PATH}` }, output: OUTPUT },
    { id: "a2", kind: "tool", name: "bash", status: "failed", args: { cmd: "go build" }, error: `error: ${PATH}` },
    {
      id: "a3",
      kind: "subtask",
      name: "mcp__filesystem_server__read_multiple_files_recursively_with_a_long_name",
      status: "running",
      args: { script: `line one\nline two ${PATH}` },
      children: [
        { id: "c1", kind: "tool", name: "read_file", status: "done", args: { path: PATH } },
        { id: "c2", kind: "tool", name: "bash", status: "failed", args: { cmd: "ls" }, error: `ls: ${PATH}: No such file` },
      ],
    },
  ],
  workers: [
    {
      id: "w1",
      name: "Curie",
      name_index: 1,
      avatar_index: 0,
      kind: "coder",
      status: "failed",
      processes: [
        { pid: 4242, program: "/opt/tools/very-long-install-prefix/bin/codex-cli-wrapper-with-a-long-name" },
        { pid: 99, program: "bash" },
      ],
      output: OUTPUT,
      error: `panic: ${PATH}`,
    },
  ],
});
const previews = createArtifactPreviews();
const empty = signal(false);
const detail = signal<ActivityDetailRef>({ itemID: "r1", kind: "activity" });
const item = () =>
  empty()
    ? { id: "r1", role: "agent", text: "", taskId: "t1", status: "running", activity: normalizeActivity({}), plan: null, reasoning: "" }
    : { id: "r1", role: "agent", text: "", taskId: "t1", status: "failed", activity, plan: null, reasoning: "" };

const lines = signal<Record<number, OverflowLineFrame>>({});
const panel = signal(0);
probeOverflowLines((frame) => lines.update((all) => ({ ...all, [frame.line]: frame })));

function Show(props: { id: string; label: string; onPress: () => void }) {
  // What the panel showed goes: its lines report nothing more.
  return <Button testID={props.id} size="xs" label={props.label} onPress={() => (lines.set({}), props.onPress())} />;
}

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row gap-2 p-1">
        <Show id="show-activity" label="activity" onPress={() => detail.set({ itemID: "r1", kind: "activity" })} />
        <Show id="show-worker" label="worker" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w1" })} />
        <Show id="show-missing-worker" label="missing" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w9" })} />
        <Show id="show-empty" label="empty" onPress={() => empty.set(true)} />
      </View>
      <View class="h-[600px]" onLayout={(e) => panel.set(e.bounds.size.width)}>
        <ActivityDetailPanel
          detail={detail()}
          item={item() as any}
          context="Clean the disk"
          endpointRef=""
          topicID=""
          previews={previews}
          class="flex-1"
          onClose={() => {}}
        />
      </View>
      <Text class="text-[6px]">{JSON.stringify({ panel: panel(), lines: Object.values(lines()) })}</Text>
    </View>
  );
}

mount(() => <Page />);
