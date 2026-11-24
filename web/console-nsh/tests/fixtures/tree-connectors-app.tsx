// A test entry for tests/chat-tree-connectors.test.tsx: the two trees drawn with TreeBranch on the
// terminal as wide as the window. A process tree (ChatProcessTree's ProcessRows) with a wrapping
// command, nested children, a last child with children of its own and a single child; a call
// tree (ActivityCallTree) with calls not kept, a multiline command, a failed shell call's result,
// an error and a last call with a result; and a call tree of one call. Buttons drop the process
// tree's last root and its first child's last child (the row before becomes the last), and
// measure every probed part (TreeBranch's measureTreeParts), read out below as JSON.
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../components/ui";
import { ChatTerminal } from "../../components/chat/ChatTerminal";
import { ProcessRows } from "../../components/chat/ChatProcessTree";
import { ActivityCallTree } from "../../components/chat/ChatStatusCard";
import { measureTreeParts, probeTreeParts } from "../../components/chat/TreeBranch";
import type { ProcNode } from "../../components/chat/taskProcesses";
import type { PartFrame } from "../../components/shared/partProbe";
import { normalizeActivity } from "../../lib/core/chat-task-history.js";

probeTreeParts(true);

const NOW = new Date().toISOString();
const LONG = "node /home/user/projects/very/long/path/to/some/deeply/nested/module/server.js --port 5173 --host 0.0.0.0 --watch --inspect";

function proc(pid: number, name: string, command: string, children?: ProcNode[]): ProcNode {
  return { pid, ppid: 1, name, command, started_at: NOW, children };
}

const FULL: ProcNode[] = [
  proc(10, "npm", LONG, [proc(11, "node", "node server.js", [proc(12, "esbuild", "esbuild --watch")]), proc(13, "sh", `sh -c ${LONG}`)]),
  proc(20, "python3", "python3 -m http.server", [proc(21, "sleep", "sleep 100")]),
];
const nodes = signal<ProcNode[]>(FULL);

const activity = normalizeActivity({
  history: [
    {
      id: "a1",
      kind: "subtask",
      name: "subtask",
      status: "failed",
      children: [
        { id: "c1", kind: "tool", name: "read_file", status: "done", args: { path: "/tmp/a.txt" } },
        {
          id: "c2",
          kind: "tool",
          name: "bash",
          status: "failed",
          args: { cmd: `go vet ./...\ngo test ./...\n${LONG}` },
          shell: { exit_code: 1, stderr: "vet: bad\nline two of stderr\nline three", stdout: "ok   pkg/a\nFAIL pkg/b" },
        },
        { id: "c3", kind: "tool", name: "url_fetch", status: "failed", args: { url: "https://example.com" }, error: `fetch failed: ${LONG}` },
        { id: "c4", kind: "tool", name: "bash", status: "failed", args: { cmd: "false" }, shell: { exit_code: 2, stderr: "boom", stdout: "" } },
      ],
    },
    { id: "a2", kind: "subtask", name: "one", status: "done", children: [{ id: "s1", kind: "tool", name: "bash", status: "failed", args: { cmd: "ls" }, error: "ls: no such file" }] },
  ],
});
// The history above is never empty; a null here is a broken fixture, not a tree to hide.
if (!activity) throw new Error("tree-connectors fixture: normalizeActivity dropped the call history");
const calls = activity.history;

const frames = signal<{ version: number; parts: Record<string, PartFrame> }>({ version: 0, parts: {} });
let version = 0;
async function measure() {
  const parts = await measureTreeParts();
  frames.set({ version: ++version, parts });
}

function Page() {
  return (
    <View class="flex-1 bg-paper">
      <View class="flex-row flex-wrap gap-2 p-1">
        <Button testID="measure" size="xs" label="measure" onPress={() => void measure()} />
        <Button testID="drop-last" size="xs" label="drop" onPress={() => nodes.set(nodes().slice(0, -1))} />
        <Button
          testID="drop-child"
          size="xs"
          label="child"
          onPress={() => nodes.set(nodes().map((node, index) => (index === 0 ? { ...node, children: node.children?.slice(0, 1) } : node)))}
        />
      </View>
      <View class="px-1">
        <ChatTerminal testID="trees">
          <View testID="process-tree">
            <ProcessRows nodes={nodes()} stopping={{}} onStop={() => {}} />
          </View>
          <View testID="call-tree">
            <ActivityCallTree itemID="many" calls={calls[0].children} omitted={2} />
          </View>
          <View testID="single-tree">
            <ActivityCallTree itemID="single" calls={calls[1].children} />
          </View>
        </ChatTerminal>
      </View>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
