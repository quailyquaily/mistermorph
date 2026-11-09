// A test entry for tests/chat-detail-panel.test.tsx: the detail panel (ActivityDetailPanel) beside
// nothing, showing a reply that the buttons change as the history would: a plan step added while
// it is open, the reply gone, a selection with nothing to show.
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

const item = () =>
  gone()
    ? null
    : { id: "r1", role: "agent", text: "", taskId: "t1", status: "running", plan: { steps: steps() }, activity: null, reasoning: "" };

function Gallery() {
  return (
    <View class="flex-1 flex-row bg-background">
      <View class="w-[120px] gap-2 p-2">
        <Button testID="add-step" size="xs" label="add" onPress={() => steps.update((list) => [...list.map((s) => ({ ...s, status: "completed" })), { step: `Step ${list.length + 1}`, status: "in_progress" }])} />
        <Button testID="drop-reply" size="xs" label="drop" onPress={() => gone.set(true)} />
        <Button testID="show-reasoning" size="xs" label="reasoning" onPress={() => detail.set({ itemID: "r1", kind: "reasoning" })} />
        <Button testID="show-missing-worker" size="xs" label="worker" onPress={() => detail.set({ itemID: "r1", kind: "worker", workerID: "w9" })} />
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
