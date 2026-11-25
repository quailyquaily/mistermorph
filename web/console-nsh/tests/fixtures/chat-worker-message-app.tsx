// A test entry for tests/chat-worker-message.test.tsx: a running task's worker panel
// (ActivityDetailPanel) on a 360pt phone, dark as the chat page draws it, with three workers: a
// running subagent (Curie), a running coder (Einstein) and a finished subagent (Noether). Buttons pick
// the worker shown and the Console's language. Sending a worker a message is reported as a
// `morph.fixture.event` post ({ name: "send", data: { workerID, text } }) and answered as
// `host.params.refuse` says (a runtime `code`, or queued when unset); sending to the main agent is
// reported as "parent". The test plays the runtime's reports of Curie's messages with
// `app.host.send("morph.fixture.messages", [...])`, and gets the panel's parts' frames as "part"
// events.
import { host, mount, signal, View } from "nsh";
import { Button } from "../../components/ui";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { ActivityDetailPanel } from "../../pages/chat/ActivityDetailPanel";
import { normalizeActivity } from "../../lib/core/chat-task-history.js";
import { localeState } from "../../lib/core/context.js";

const params = (host.params || {}) as Record<string, any>;

function report(name: string, data: unknown = null) {
  host.post("morph.fixture.event", { name, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) });
}

const curieMessages = signal<Record<string, unknown>[]>([]);
host.on("morph.fixture.messages", (messages: unknown) => curieMessages.set(Array.isArray(messages) ? (messages as Record<string, unknown>[]) : []));

const item = () => ({
  id: "reply-1",
  role: "agent",
  text: "",
  taskId: "task_1",
  status: "running",
  activity: normalizeActivity({
    workers: [
      { id: "worker-1", name: "Curie", name_index: 1, avatar_index: 0, kind: "subagent", status: "running", task: "write a haiku about cats", messages: curieMessages() },
      { id: "worker-2", name: "Einstein", name_index: 0, avatar_index: 1, kind: "coder", status: "running", task: "fix the build" },
      { id: "worker-3", name: "Noether", name_index: 4, avatar_index: 2, kind: "subagent", status: "done", task: "summarize", result: "done" },
    ],
  }),
});

const selected = signal("worker-1");
const previews = createArtifactPreviews();

function Fixture() {
  return (
    <View class="w-[360px] gap-2 bg-paper">
      <View class="flex-row flex-wrap gap-1 p-1">
        {["worker-1", "worker-2", "worker-3"].map((id) => (
          <Button testID={`pick-${id}`} variant="outlined" size="xs" label={id} onPress={() => selected.set(id)} />
        ))}
        {["en", "zh", "ja"].map((lang) => (
          <Button testID={`lang-${lang}`} variant="outlined" size="xs" label={lang} onPress={() => localeState.setLanguage(lang)} />
        ))}
      </View>
      <ActivityDetailPanel
        detail={{ itemID: "reply-1", kind: "worker", workerID: selected() }}
        item={item() as any}
        context="write three haiku"
        endpointRef=""
        topicID=""
        previews={previews}
        phone
        dark
        class="h-[560px] w-[360px]"
        onClose={() => undefined}
        onWorkerMessage={async (workerID, text) => {
          report("send", { workerID, text });
          const code = String(params.refuse || "");
          return code ? { ok: false, code, message: `refused: ${code}` } : { ok: true };
        }}
        onSendToParent={async (text) => {
          report("parent", { text });
          return true;
        }}
        onPartLayout={(name, frame) => report("part", { name, frame })}
      />
    </View>
  );
}

mount(() => <Fixture />);
