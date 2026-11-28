// A test entry for tests/chat-file-drop.test.tsx: the real ChatComposer as a drop target among
// others. From the top: a strip that listens to nothing; a drop target of another part of the page
// (`other`); and a listening box (`around`) holding a strip of its own and the composer. Every
// drop a listener hears is logged, as JSON: a drop is heard by the closest listener around where
// it lands, once, and by no listener further out. Below them, the mark the composer's frame shows
// while files are dragged over it, on a frame of the composer's shape (`mark`): a drag's enter and
// leave cannot be driven in a test, so the mark is drawn here by itself.
import { mount, signal, Text, View } from "nsh";
import { ChatComposer, ComposerDropMark } from "../../components/chat/ChatComposer";
import { composerFrameClass } from "../../components/chat/composerField";
import { droppedURIs } from "../../components/chat/fileDrop";

const draft = signal("");
const log = signal<string[]>([]);
const heard = (who: string) => (event: unknown) => log.update((all) => [...all, `${who}:${droppedURIs(event).join("|")}`]);

mount(() => (
  <View class="flex-1 bg-paper p-4 gap-2">
    <View class="h-10" testID="plain" />
    <View class="h-10" testID="other" onFileDrop={heard("other")} />
    <View class="gap-2" testID="around" onFileDrop={heard("around")}>
      <View class="h-10" testID="around-pad" />
      <ChatComposer testID="composer" value={draft()} onChange={(value) => draft.set(value)} placeholder="Message" onDropFiles={(uris) => heard("composer")({ uris })} dropLabel="Drop here" />
    </View>
    <View class={`${composerFrameClass(false)} h-14`} testID="mark">
      <ComposerDropMark label="Drop to add to this message" />
    </View>
    <Text testID="log">{JSON.stringify(log())}</Text>
  </View>
));
