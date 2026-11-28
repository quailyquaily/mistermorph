// A test entry for tests/chat-image-paste-web.test.tsx: the real ChatComposer with the chat's paste
// handling (components/chat/imagePaste.ts `createComposerPaste`) and a stand-in for the draft's
// attachments. Each attached image is logged as `name|type|size`, each refusal as its words; the
// field's text is shown too. Run headless and in Chrome (`nsh test --target web`), where the test's
// paste is a real ClipboardEvent the page's runtime reads (nsh.js `pasted`).
import { mount, signal, Text, View } from "nsh";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { createComposerPaste } from "../../components/chat/imagePaste";

const draft = signal("");
const attached = signal<string[]>([]);
const refusals = signal<string[]>([]);
const sent = signal(0);

const paste = createComposerPaste({
  draft: () => "draft",
  blocked: () => "",
  takeFiles: (files) => attached.update((all) => [...all, ...files.map((file) => `${file.name}|${file.type}|${file.size}`)]),
  refuse: (text) => refusals.update((all) => [...all, text]),
  text: (key, values) => `${key}:${values.names ?? ""}:${values.format ?? ""}`,
});

mount(() => (
  <View class="flex-1 bg-paper p-4 gap-2">
    <Text testID="attached">{`attached=${JSON.stringify(attached())}`}</Text>
    <Text testID="refusals">{`refusals=${JSON.stringify(refusals())}`}</Text>
    <Text testID="draft">{`draft=${JSON.stringify(draft())}`}</Text>
    <Text testID="sent">{`sent=${sent()}`}</Text>
    <ChatComposer
      testID="composer"
      value={draft()}
      onChange={(value) => draft.set(value)}
      placeholder="Message"
      onSubmit={() => sent.update((n) => n + 1)}
      onPasteImages={(files) => void paste(files)}
    />
  </View>
));
