// A test entry for tests/chat-detail-panel.test.tsx: the detail panel (ActivityDetailPanel) beside
// nothing, showing a reply that the buttons change as the history would: a plan step added while
// it is open, the reply gone, a selection with nothing to show, progress with nothing yet, a coder
// that wrote nothing yet and a failed reply.
import { mount, signal, View } from "nsh";
import { Button } from "../../components/ui";
import type { ActivityDetailRef } from "../../components/chat/activityDetail";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { ActivityDetailPanel } from "../../pages/chat/ActivityDetailPanel";

const previews = createArtifactPreviews();
const steps = signal([{ step: "Look around", status: "in_progress" }]);
const gone = signal(false);
const detail = signal<ActivityDetailRef>({ itemID: "r1", kind: "plan" });
const closes = signal(0);
const workers = signal<any[] | null>(null);
const failed = signal(false);

const item = () =>
  gone()
    ? null
    : {
        id: "r1",
        role: "agent",
        text: "",
        taskId: "t1",
        status: failed() ? "failed" : "running",
        plan: { steps: steps() },
        activity: workers() ? { workers: workers() } : null,
        reasoning: "",
      };

function Gallery() {
  return (
    <View class="flex-1 flex-row bg-background">
      <View class="w-[120px] gap-2 p-2">
        <Button testID="add-step" size="xs" label="add" onPress={() => steps.update((list) => [...list.map((s) => ({ ...s, status: "completed" })), { step: `Step ${list.length + 1}`, status: "in_progress" }])} />
        <Button testID="drop-reply" size="xs" label="drop" onPress={() => gone.set(true)} />
        <Button testID="show-reasoning" size="xs" label="reasoning" onPress={() => detail.set({ itemID: "r1", kind: "reasoning" })} />
        <Button testID="show-missing-worker" size="xs" label="worker" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w9" })} />
        <Button testID="show-activity" size="xs" label="activity" onPress={() => detail.set({ itemID: "r1", kind: "activity" })} />
        <Button
          testID="show-coder"
          size="xs"
          label="coder"
          onPress={() => {
            workers.set([
              { id: "w1", name: "Curie", kind: "coder", status: "running", output: "" },
              { id: "w2", name: "Noether", kind: "subagent", status: "running", output: "" },
            ]);
            detail.set({ itemID: "r1", kind: "worker", workerID: "w1" });
          }}
        />
        <Button testID="show-subagent" size="xs" label="subagent" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w2" })} />
        <Button testID="fail" size="xs" label="fail" onPress={() => failed.set(true)} />
        <Button testID="closes" size="xs" label={`closed ${closes()}`} onPress={() => {}} />
      </View>
      <View class="w-[314px] pl-1">
        <ActivityDetailPanel
          detail={detail()}
          item={item()}
          context="Clean the disk"
          endpointRef=""
          topicID=""
          previews={previews}
          class="flex-1"
          onClose={() => closes.update((n) => n + 1)}
        />
      </View>
    </View>
  );
}

mount(() => <Gallery />);
