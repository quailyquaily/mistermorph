// The real ChatComposer's voice button in each voice state, set by the buttons above it: idle,
// recording, transcribing, the composer disabled, and a task running (Send is Stop then). The report counts the button's presses and
// gives the colour its glyph is drawn in, in the theme shown. tests/chat-voice-icon.test.tsx reads it.
//
// hold-turns / release-turns: tests/chat-composer-drum.test.tsx holds the end of each animated turn
// (AnimatedValue.timing: the native animation runs and ends as ever, but its promise resolves only
// on release-turns), so the drum, which goes when its turn's promise resolves, is still there when
// the step that started the turn returns, however fast headless finishes the animation. The
// `turns:` line lists where each held turn went to (the drum: 1 for Send, 0 for the mic).
import { createAnimatedValue, mount, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { ChatComposer, voiceButtonLook } from "../../components/chat/ChatComposer";

type VoiceState = "idle" | "recording" | "transcribing";

const draft = signal("");
const state = signal<VoiceState>("idle");
const disabled = signal(false);
const stop = signal(false);
const presses = signal(0);

let holdTurns = false;
const heldTurns = signal<number[]>([]);
let releases: (() => void)[] = [];
type Timing = (to: number, options?: unknown) => Promise<{ finished: boolean }>;
const valueProto = Object.getPrototypeOf(createAnimatedValue(0)) as { timing: Timing };
const timing = valueProto.timing;
valueProto.timing = function (this: unknown, to: number, options?: unknown) {
  const run = timing.call(this, to, options);
  if (!holdTurns) return run;
  heldTurns.update((turns) => [...turns, to]);
  // The gate is taken at the call, so a release before the animation ended still lets it through.
  const gate = new Promise<void>((resolve) => releases.push(resolve));
  return Promise.all([run, gate]).then(([result]) => result);
};
function releaseTurns() {
  const pending = releases;
  releases = [];
  for (const release of pending) release();
}

const label = () => (state() === "recording" ? "Stop and transcribe" : "Voice input");

function Set(props: { name: string; onPress: () => void }) {
  return (
    <Button testID={props.name} onPress={props.onPress}>
      <Text>{props.name}</Text>
    </Button>
  );
}

mount(() => (
  <View class="flex-1 bg-background p-4 gap-2">
    <View class="flex-row gap-2">
      <Set name="set-idle" onPress={() => state.set("idle")} />
      <Set name="set-recording" onPress={() => state.set("recording")} />
      <Set name="set-transcribing" onPress={() => state.set("transcribing")} />
      <Set name="toggle-disabled" onPress={() => disabled.update((value) => !value)} />
      <Set name="toggle-stop" onPress={() => stop.update((value) => !value)} />
      <Set name="hold-turns" onPress={() => (holdTurns = true)} />
      <Set name="release-turns" onPress={releaseTurns} />
    </View>
    <ChatComposer
      value={draft()}
      onChange={(value) => draft.set(value)}
      disabled={disabled()}
      voiceAvailable
      stopMode={stop()}
      voiceState={state()}
      voiceLabel={label()}
      onVoice={() => presses.update((count) => count + 1)}
    />
    <Text>{`turns:${JSON.stringify(heldTurns())}`}</Text>
    <Text>{JSON.stringify({ presses: presses(), tint: String(token(voiceButtonLook(state()).tint)).toLowerCase() })}</Text>
  </View>
));
