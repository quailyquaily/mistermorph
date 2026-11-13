// A test entry for tests/chat-output-overflow.test.tsx and tests/chat-activity-params.test.tsx: the
// detail panel (ActivityDetailPanel) as wide as the window, showing a reply's progress or one of its
// coders, with runs that do not wrap (a long tool name, a long process) beside parameters and
// nested calls (short, long, unbroken and multiline commands, a coder's own calls, an empty one)
// and output, notes and errors that wrap. Every run's line (OverflowLine) reports its widths,
// whether it scrolls and its offset, and every parameter's and nested call's parts where they lie
// (probeActivityParams); they and the panel's width are read out below it as JSON. The buttons
// switch what the panel shows, the empty states included, and draw it as the workbench does
// (`dark`: one scroll area, where runs wrap).
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../components/ui";
import type { ActivityDetailRef } from "../../components/chat/activityDetail";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { probeActivityParams } from "../../components/chat/ChatStatusCard";
import type { PartFrame } from "../../components/shared/partProbe";
import { probeOverflowLines, type OverflowLineFrame } from "../../components/chat/OverflowLine";
import { ActivityDetailPanel } from "../../pages/chat/ActivityDetailPanel";
import { normalizeActivity } from "../../lib/core/chat-task-history.js";

const PATH = "/home/user/projects/very/long/path/to/some/deeply/nested/module/that/never/ends/file_name.go:1234:56";
// A command with no space to break at: it can only break inside.
const TOKEN = `printf%s${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(3)}`;
// A value longer than the 120 characters a nested call shows: the panel shows a parameter whole.
const PROMPT = "Write story.c in /tmp/try-cc (create directory if needed), a C99 program that prints a short story one line at a time, then build it and run it: whole-value-end";
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
    { id: "a4", kind: "tool", name: "bash", status: "done", args: { cmd: TOKEN } },
    { id: "a5", kind: "tool", name: "bash", status: "queued", args: { cmd: "" } },
    {
      id: "a6",
      kind: "tool",
      name: "coder",
      status: "failed",
      args: { task: "Fix the build", backend: "codex", cwd: PATH },
      children: [
        { id: "k1", kind: "tool", name: "bash", status: "done", args: { cmd: `rg -n "OverflowLine" ${PATH}` } },
        { id: "k2", kind: "tool", name: "bash", status: "done", args: { command: TOKEN } },
        { id: "k3", kind: "tool", name: "bash", status: "failed", args: { cmd: "go vet\ngo test" } },
      ],
    },
    { id: "a7", kind: "tool", name: "write_note", status: "done", args: { task: PROMPT } },
  ],
  workers: [
    {
      id: "w1",
      name: "Curie",
      name_index: 1,
      avatar_index: 0,
      kind: "coder",
      status: "failed",
      activity_id: "a6",
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
const dark = signal(false);
const detail = signal<ActivityDetailRef>({ itemID: "r1", kind: "activity" });
const item = () =>
  empty()
    ? { id: "r1", role: "agent", text: "", taskId: "t1", status: "running", activity: normalizeActivity({}), plan: null, reasoning: "" }
    : { id: "r1", role: "agent", text: "", taskId: "t1", status: "failed", activity, plan: null, reasoning: "" };

const lines = signal<Record<number, OverflowLineFrame>>({});
const panel = signal(0);
probeOverflowLines((frame) => lines.update((all) => ({ ...all, [frame.line]: frame })));
const parts = signal<Record<string, PartFrame>>({});
probeActivityParams((name, frame) => parts.update((all) => ({ ...all, [name]: frame })));

function Show(props: { id: string; label: string; onPress: () => void }) {
  // What the panel showed goes: its lines report nothing more.
  return <Button testID={props.id} size="xs" label={props.label} onPress={() => (lines.set({}), parts.set({}), props.onPress())} />;
}

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row gap-2 p-1">
        <Show id="show-activity" label="activity" onPress={() => detail.set({ itemID: "r1", kind: "activity" })} />
        <Show id="show-worker" label="worker" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w1" })} />
        <Show id="show-missing-worker" label="missing" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w9" })} />
        <Show id="show-empty" label="empty" onPress={() => empty.set(true)} />
        <Show id="show-dark" label="dark" onPress={() => dark.set(true)} />
      </View>
      <View class="h-[600px]" onLayout={(e) => panel.set(e.bounds.size.width)}>
        {/* A panel of its own for each look: a line takes its way (scroll or wrap) as it is built. */}
        <Each of={[dark()]} key={(on) => String(on)}>
          {(on) => (
            <ActivityDetailPanel
              detail={detail()}
              item={item() as any}
              context="Clean the disk"
              endpointRef=""
              topicID=""
              previews={previews}
              dark={on()}
              class="flex-1"
              onClose={() => {}}
            />
          )}
        </Each>
      </View>
      <Text class="text-[6px]">{JSON.stringify({ panel: panel(), lines: Object.values(lines()), parts: parts() })}</Text>
    </View>
  );
}

mount(() => <Page />);
