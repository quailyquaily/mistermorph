// A test entry for tests/chat-worker-names.test.tsx: a task's worker roster (ChatWorkerRoster) at
// phone width, as the runtime records its workers: scientists by name index, a nested coder, a
// repeat once the pool ran out, and a worker from before the scientist pool, with buttons that
// switch the Console's language.
import { mount, View } from "nsh";
import { Button } from "../../components/ui";
import { ChatWorkerRoster } from "../../components/chat/ChatWorkerRoster";
import { keyedState } from "../../components/chat/rowState";
import { normalizeActivity } from "../../lib/core/chat-task-history.js";
import { localeState } from "../../lib/core/context.js";
import { WORKER_NAME_POOLS } from "../../lib/core/worker-identity.js";

const order = [4, 1, 0, 31, 23, 6, 15, 29, 2, 3, 7, 28];
const workers = order.map((nameIndex, n) => ({
  id: `worker-${n + 1}`,
  name: WORKER_NAME_POOLS.en[nameIndex],
  name_index: nameIndex,
  avatar_index: n % 7,
  kind: n % 2 ? "coder" : "subagent",
  status: n < 3 ? "running" : "done",
}));
workers.push(
  { id: "worker-33", name: "Darwin-2", name_index: 35, avatar_index: 4, kind: "coder", status: "done" },
  { id: "worker-34", name: "Hazel", name_index: 13, avatar_index: 5, kind: "subagent", status: "failed" },
);
const activity = normalizeActivity({ workers });
const selected = keyedState<string>();

function Gallery() {
  return (
    <View class="w-[360px] gap-3 bg-paper p-4">
      <View class="flex-row gap-2">
        {["en", "zh", "ja", "fr"].map((lang) => (
          <Button testID={`lang-${lang}`} variant="outlined" size="xs" label={lang} onPress={() => localeState.setLanguage(lang)} />
        ))}
      </View>
      <ChatWorkerRoster itemID="task-1" activity={activity} status="running" selected={selected} />
    </View>
  );
}

mount(() => <Gallery />);
