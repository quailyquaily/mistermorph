// A test entry for tests/shortcut-eligibility.test.tsx: the application shortcuts that belong to a
// component rather than to the frame's dispatcher, each behind the shared policy
// (lib/shortcutPolicy.ts): a question's number keys (ChatQuestionCard) and a panel's Escape
// (`bindPaneEscape`). Without a host the Console is a browser's, so the window's width decides.
// Tab from the window's start lands on the question's first choice. What happened is read out as
// text: the policy's word, the answers given and whether the panel is open.
import { mount, signal, Text, View } from "nsh";
import { ChatQuestionCard, type QuestionState } from "../../components/chat/ChatQuestionCard";
import { keyedState } from "../../components/chat/rowState";
import { bindPaneEscape } from "../../components/ui";
import { shortcutsEligible } from "../../lib/shortcutPolicy";

const QUESTION = { id: "q1", text: "Which environment?", options: [{ label: "Staging" }, { label: "Production" }], status: "open" };
const states = keyedState<QuestionState>();
const answers = signal<string[]>([]);
const paneOpen = signal(true);

function Pane() {
  bindPaneEscape(() => paneOpen.set(false));
  return <Text testID="pane">pane</Text>;
}

function Page() {
  return (
    <View class="flex-1 bg-paper p-4">
      <ChatQuestionCard
        question={QUESTION}
        live
        states={states}
        onAnswer={(answer) => {
          answers.set([...answers(), answer.text !== undefined ? `text:${answer.text}` : `option:${answer.option}`]);
          // Stays open for the next key: the task did not take the answer.
          answer.done(false, "kept open");
        }}
      />
      <Text testID="eligible">{`eligible:${shortcutsEligible()}`}</Text>
      <Text testID="answers">{`answers:${answers().join(",")}`}</Text>
      <Text testID="pane-state">{`pane:${paneOpen() ? "open" : "closed"}`}</Text>
      {paneOpen() ? <Pane /> : null}
    </View>
  );
}

mount(() => <Page />);
