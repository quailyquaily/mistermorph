// A test entry for tests/chat-markdown-tables.test.tsx: replies' Markdown (ChatMarkdown) with wide
// and fitting tables in the boxes a reply's text sits in: the page's column, a reply's body as
// ChatHistoryItem draws it (ChatRichContent in a 736pt-at-most column, the reply's side room on its
// right), a question card's row (a label, then the Markdown as `flex-1`), a 240pt panel, a list item,
// plus a table that fits, a two-column table that fits by wrapping, empty Markdown and a streamed
// table that grows (`tables-grow`). Every box reports its frame and the page its vertical offset, as
// JSON in `tables-report` at the end.
import { mount, Scroll, signal, Text, View, type Bounds } from "nsh";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { ChatMarkdown } from "../../components/chat/ChatMarkdown";
import { ChatRichContent } from "../../components/chat/ChatRichContent";

const ROWS = [
  "| Service | Region | Status | Latency p50 | Latency p99 | Owner | Notes |",
  "| --- | --- | --- | ---: | ---: | --- | --- |",
  "| api-gateway | us-east-1 | Running | 12 ms | 180 ms | [platform team](https://example.com/platform) | Rolled out on Tuesday |",
  "| billing-worker | eu-west-2 | Degraded | 40 ms | 1200 ms | payments | Queue backlog after the migration |",
  "| search-indexer | ap-southeast-1 | Running | 8 ms | 95 ms | [search](https://example.com/search) | — |",
];
const WIDE = ["Before the table.", "", ...ROWS, "", "After the table."].join("\n");
const LIST = ["1. First step:", "", ...ROWS.map((row) => `   ${row}`), "", "2. Second step."].join("\n");
const FIT = ["| Key | Value |", "| --- | --- |", "| mode | fit |"].join("\n");
const PROSE = ["| Key | Meaning |", "| --- | --- |", "| retry | How many times a failed request is sent again before giving up |"].join("\n");
const STREAM_START = ["Streaming:", "", "| Step | State |", "| --- | --- |", "| build | done |"].join("\n");
const STREAM_MORE = [
  "",
  "| deploy to the staging cluster in the eastern region | waiting for the database migration to finish before it starts |",
  "| notify the release channel with the summary of changes | queued behind the deploy, then posted to every subscriber |",
].join("\n");

/** The room a reply leaves on its right on a phone (ChatHistoryItem's sideRoom at 390pt). */
const REPLY_SIDE_ROOM = 10;

const frames = signal<Record<string, { x: number; y: number; width: number; height: number }>>({});
const offset = signal(0);
const stream = signal(STREAM_START);
const previews = createArtifactPreviews();

function report(name: string) {
  return (event: { bounds: Bounds }) => {
    const { origin, size } = event.bounds;
    frames.update((all) => ({ ...all, [name]: { x: origin.x, y: origin.y, width: size.width, height: size.height } }));
  };
}

function Case(props: { name: string; source: string; streaming?: boolean }) {
  return (
    <View testID={`tables-${props.name}`} onLayout={report(props.name)}>
      <ChatMarkdown source={props.source} streaming={props.streaming} />
    </View>
  );
}

function Page() {
  return (
    <Scroll class="flex-1 bg-paper" testID="tables-scroll" onScroll={(event) => offset.set(Math.round(event.offset.y))}>
      <View class="gap-4 p-3" onLayout={report("column")}>
        <View testID="tables-grow" class="h-6 w-16 bg-muted" onPress={() => stream.update((source) => source + STREAM_MORE)}>
          <Text class="text-xs">grow</Text>
        </View>
        <Case name="page" source={WIDE} />
        {/* A reply's body (ChatHistoryItem: its row, then agentBody). */}
        <View class="w-full max-w-[832px] self-center" style={{ paddingRight: REPLY_SIDE_ROOM }}>
          <View testID="tables-reply" class="max-w-[736px] gap-[7px]" onLayout={report("reply")}>
            <ChatRichContent source={WIDE} ownerKey="r1:reply" endpointRef="" previews={previews} />
          </View>
        </View>
        {/* A question card's row (ChatQuestionCard). */}
        <View testID="tables-question" class="flex-row gap-2" onLayout={report("question")}>
          <Text class="w-16 text-xs">Asked</Text>
          <ChatMarkdown source={WIDE} class="flex-1" />
        </View>
        <View class="w-[240px] border border-line" onLayout={report("panel-box")}>
          <Case name="panel" source={WIDE} />
        </View>
        <Case name="list" source={LIST} />
        <Case name="fit" source={FIT} />
        <Case name="prose" source={PROSE} />
        <Case name="empty" source="" />
        <Case name="stream" source={stream()} streaming />
        <View class="h-[900px]" />
        <Text class="text-[6px]">{JSON.stringify({ offset: offset(), frames: frames() })}</Text>
      </View>
    </Scroll>
  );
}

mount(() => <Page />);
