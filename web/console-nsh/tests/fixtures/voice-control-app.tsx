// The real ChatComposer's voice button in each voice state, set by the buttons above it: idle,
// recording, transcribing, and the composer disabled. The report counts the button's presses. tests/chat-voice-icon.test.tsx reads it.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { ChatComposer } from "../../components/chat/ChatComposer";

type VoiceState = "idle" | "recording" | "transcribing";

const draft = signal("");
const state = signal<VoiceState>("idle");
const disabled = signal(false);
const presses = signal(0);

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
    </View>
    <ChatComposer
      value={draft()}
      onChange={(value) => draft.set(value)}
      disabled={disabled()}
      voiceAvailable
      voiceState={state()}
      voiceLabel={label()}
      onVoice={() => presses.update((count) => count + 1)}
    />
    <Text>{JSON.stringify({ presses: presses() })}</Text>
  </View>
));
