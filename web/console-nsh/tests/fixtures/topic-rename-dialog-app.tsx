// A test entry for tests/topic-rename-dialog-layout.test.tsx: the real topic rename dialog, open
// on a topic, with its parts' frames (field, regenerate, cancel, save) read out beside it as JSON.
// `id:fixture-suggest` holds a suggestion that never answers (Regenerate loading).
import { mount, signal, Text, View, type Bounds } from "nsh";
import { Button } from "../../components/ui";
import { createTopicRename, type TopicRename } from "../../pages/chat/topicRename";
import { TopicRenameDialog } from "../../pages/chat/TopicRenameDialog";

const frames = signal<Record<string, { w: number; h: number }>>({});

function Page() {
  const rename: TopicRename = createTopicRename({
    suggest: () => new Promise(() => {}),
    save: async (_endpointRef, topicID, title) => ({ id: topicID, title }),
    messages: () => ({ empty: "Enter a topic name.", saveFailed: "Could not rename.", suggestFailed: "Could not suggest." }),
  });
  rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Weekly soups" });
  const record = (part: string, bounds: Bounds) =>
    frames.update((all) => ({ ...all, [part]: { w: Math.round(bounds.size.width * 10) / 10, h: Math.round(bounds.size.height * 10) / 10 } }));
  return (
    <View class="flex-1 gap-2 bg-background p-4">
      <Button testID="fixture-suggest" variant="outlined" size="xs" label="Suggest" onPress={() => void rename.regenerate()} />
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
      <TopicRenameDialog rename={rename} regenerateDisabled={false} onPartLayout={record} />
    </View>
  );
}

mount(() => <Page />);
