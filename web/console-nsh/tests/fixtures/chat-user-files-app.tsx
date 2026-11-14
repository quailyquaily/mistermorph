// A test entry for tests/chat-user-files.test.tsx: real sent messages (ChatHistoryItem) with text
// alone, text and a file, a file alone, several files with long names, and a system message, each in
// a region of its own (`v-<name>`), plus a `recycled` row whose message a button swaps (a List cell
// showing another message). The frames of each bubble's parts (`onPartLayout`) are read out as
// `<region>:<part>`, and the previews and copies the rows asked for in the log.
import { mount, signal, Text, View } from "nsh";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { ChatHistoryItem, type ChatRowContext, type HistoryItem } from "../../components/chat/ChatHistoryItem";
import { createReceivedFiles } from "../../components/chat/ReceivedFile";
import { keyedState } from "../../components/chat/rowState";
import type { PartFrame } from "../../components/shared/partProbe";

const LONG = "a-very-long-screenshot-file-name-that-keeps-going-and-going-2026-11-13-at-10.42.17-final-v2.png";
const UNBROKEN = "Screenshot_20261113_104217_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop.pdf";
const file = (id: string, name: string) => ({ id, name, mime: "image/png", size: 1234 });

const TEXT: HistoryItem = { id: "m0", role: "user", text: "Text only, the reference shape.", timeText: "10:00" };
const TEXT_FILE: HistoryItem = { id: "m1", role: "user", text: "Here is the screenshot.", timeText: "10:01", files: [file("f1", "screenshot.png")] };
const FILE_ONLY: HistoryItem = { id: "m2", role: "user", text: "", timeText: "10:02", files: [file("f2", "diagram.png")] };
const MULTI: HistoryItem = {
  id: "m3",
  role: "user",
  text: "Several files, with long names.",
  timeText: "10:03",
  files: [file("f3", "notes.md"), file("f4", LONG), file("f5", UNBROKEN), file("f6", "README")],
};
const SYSTEM: HistoryItem = { id: "m4", role: "system", text: "A system message stays a dashed box.", timeText: "" };

const REGIONS: [string, HistoryItem][] = [
  ["text", TEXT],
  ["text-file", TEXT_FILE],
  ["file-only", FILE_ONLY],
  ["multi", MULTI],
  ["system", SYSTEM],
];
// What the recycled row shows in turn.
const RECYCLED = [TEXT, FILE_ONLY, MULTI, TEXT];

const frames = signal<Record<string, PartFrame>>({});
const log = signal<string[]>([]);
const recycled = signal(0);
const record = (region: string) => (name: string, frame: PartFrame) => frames.update((all) => ({ ...all, [`${region}:${name}`]: frame }));

// The next message in the recycled row; its old part frames go, so only the new ones are read.
function recycle() {
  frames.update((all) => Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith("recycled:"))));
  recycled.update((n) => (n + 1) % RECYCLED.length);
}

const ctx: ChatRowContext = {
  endpointRef: () => "ep_console_local",
  topicID: () => "topic",
  copiedItemID: () => "",
  copySeq: () => 0,
  detail: () => null,
  focusReturn: () => "",
  autoPreviewItemID: () => "",
  previews: createArtifactPreviews(),
  receivedFiles: createReceivedFiles(),
  questions: keyedState(),
  elevations: keyedState(),
  folds: keyedState(),
  onCopy: (item) => log.update((all) => [...all, `copy:${item.id}`]),
  onPreviewFile: (item) =>
    log.update((all) => [...all, `preview:${item.id}:${item.name}:${item.previewItems.map((entry: any) => entry.id).join(",")}`]),
  onOpenDetail: () => {},
  onTimeClick: () => {},
  onApprove: () => {},
  onDeny: () => {},
  onQuestionAnswer: () => {},
  onElevationAnswer: () => {},
};

function App() {
  return (
    <View class="flex-1 bg-background">
      <View class="h-8 flex-row gap-1">
        <View testID="recycle" onPress={recycle} class="h-8 w-16 bg-muted">
          <Text class="text-[10px]">next</Text>
        </View>
      </View>
      <View class="h-4 overflow-hidden">
        <Text testID="frames" class="text-xs">
          {`frames:${JSON.stringify(frames())}`}
        </Text>
      </View>
      <View class="h-4 overflow-hidden">
        <Text testID="log" class="text-xs">
          {`log:${log().join("|")}`}
        </Text>
      </View>
      <View class="flex-1 gap-4">
        {REGIONS.map(([name, item]) => (
          <View testID={`v-${name}`}>
            <ChatHistoryItem item={item} ctx={ctx} onPartLayout={record(name)} />
          </View>
        ))}
        <View testID="v-recycled">
          <ChatHistoryItem item={RECYCLED[recycled()]} ctx={ctx} onPartLayout={record("recycled")} />
        </View>
      </View>
    </View>
  );
}

mount(() => <App />);
