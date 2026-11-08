// A test entry for tests/chat-status-line.test.tsx: a reply's summary line (ChatStatusCard with the
// time or duration first) as a running, finished, failed and timeless reply has it, the time alone
// above a reply and above a sent message, and the frames they lay out at, read out beside them.
import { mount, signal, Text, View } from "nsh";
import { ChatStatusCard } from "../../components/chat/ChatStatusCard";
import { ChatStatusMark } from "../../components/chat/ChatStatusMark";

type Frame = { x: number; y: number; w: number; h: number };
type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

const frames = signal<Record<string, Frame>>({});

function track(name: string) {
  return (event: LayoutEvent) => {
    const { origin, size } = event.bounds;
    frames.update((all) => ({ ...all, [name]: { x: origin.x, y: origin.y, w: size.width, h: size.height } }));
  };
}

const PLAN = { steps: [{ step: "Look around", status: "completed" }, { step: "Clean up", status: "in_progress" }] };
const ACTIVITY = { history: [{ id: "a1", kind: "tool", name: "bash", status: "running" }] };

// Each line: its status, what it shows, and the mark before it (none for a reply with no time).
const LINES = [
  { name: "running", status: "running", plan: PLAN, activity: ACTIVITY, reasoning: false, mark: { text: "10:02", duration: false } },
  { name: "done", status: "done", plan: PLAN, activity: ACTIVITY, reasoning: true, mark: { text: "2m5s", duration: true } },
  { name: "failed", status: "failed", plan: null, activity: ACTIVITY, reasoning: false, mark: { text: "4s", duration: true } },
  { name: "reasoning", status: "done", plan: null, activity: null, reasoning: true, mark: { text: "10:03", duration: false } },
  { name: "timeless", status: "running", plan: PLAN, activity: null, reasoning: false, mark: null },
];

function Gallery() {
  return (
    <View class="gap-4 bg-background p-4">
      {LINES.map((line) => (
        <View testID={`line-${line.name}`} onLayout={track(`${line.name}-card`)}>
          <ChatStatusCard
            itemID={line.name}
            plan={line.plan}
            activity={line.activity}
            hasReasoning={line.reasoning}
            status={line.status}
            expandedPanel=""
            onToggle={() => {}}
            summaryPrefix={
              line.mark ? (
                <ChatStatusMark
                  text={line.mark.text}
                  label={line.mark.text}
                  duration={line.mark.duration}
                  onPress={() => {}}
                  placement="summary"
                  onLayout={track(`${line.name}-mark`)}
                />
              ) : undefined
            }
          />
        </View>
      ))}
      <View class="w-[400px] gap-[7px]" onLayout={track("reply-column")}>
        <ChatStatusMark text="10:04" label="10:04" placement="reply" onLayout={track("reply-mark")} />
      </View>
      <View class="w-[400px] items-end gap-[7px]" onLayout={track("sent-column")}>
        <ChatStatusMark text="10:05" label="10:05" placement="sent" onLayout={track("sent-mark")} />
      </View>
      <Text testID="frames">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Gallery />);
