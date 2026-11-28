// Editing a sent message (FT140): Edit under a message, before Copy, puts it in the composer with a
// one-line quote bar and Cancel; sending replaces the message and everything after it, through the
// runtime (POST /tasks/{id}/replace); Cancel, Escape and leaving the topic give the draft back; a
// refused edit keeps the conversation and the edited text; nothing can be edited while a reply runs.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const T0 = Date.parse("2026-11-17T09:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const TOPICS = {
  body: {
    items: [
      { id: "topic-1", title: "Foxes", created_at: at(0), updated_at: at(10) },
      { id: "topic-2", title: "Owls", created_at: at(0), updated_at: at(5) },
    ],
  },
};
const CHAT = "/e/default/chat/topic-1";

function done(id: string, minute: number, question: string, answer: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    task: question,
    topic_id: "topic-1",
    status: "done",
    created_at: at(minute),
    started_at: at(minute),
    finished_at: at(minute + 0.5),
    result: { final: { output: answer } },
    ...extra,
  };
}

const TURNS = [
  done("t1", 1, "What is a fox?", "A small wild canid."),
  done("t2", 2, "Where do foxes live?", "Almost everywhere: woods, fields and towns.", {
    file_references: [{ dir_name: "file_cache_dir", path: "uploads/fox-map.png" }],
  }),
  done("t3", 3, "Name a famous fox", "Reynard, of the old fables."),
];

/** A runtime holding topic-1's tasks, which replaces them as the Go runtime does. */
function topicRuntime(options: { running?: boolean; refuse?: () => { status: number; body: unknown } | null } = {}) {
  let tasks: any[] = TURNS.map((task) => ({ ...task }));
  if (options.running) tasks.push({ ...done("t4", 4, "And their tails?", ""), status: "running", finished_at: undefined, result: undefined });
  const edits: { target: string; json: any }[] = [];
  let seq = 0;
  const api: Record<string, any> = {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": (request: ApiRequest) => {
      if (request.uri?.includes("topic_id=topic-1")) return { body: { items: [...tasks].reverse() } };
      if (request.uri?.includes("topic_id=topic-2")) return { body: { items: [{ ...done("o1", 1, "Do owls sleep?", "By day."), topic_id: "topic-2" }] } };
      return { body: { items: [] } };
    },
  };
  for (const id of ["t4", "n1", "n2"]) api[`GET /proxy:/tasks/${id}`] = () => ({ body: tasks.find((task) => task.id === id) });
  for (const target of ["t1", "t2", "t3", "n1"]) {
    api[`POST /proxy:/tasks/${target}/replace`] = (request: ApiRequest) => {
      edits.push({ target, json: request.json });
      const refused = options.refuse?.();
      if (refused) return refused;
      const index = tasks.findIndex((task) => task.id === target);
      if (index < 0) return { status: 404, body: { error: "message not found in this topic" } };
      const removed = tasks.slice(index).map((task) => task.id).reverse();
      const id = `n${++seq}`;
      // The edited message's files go with the edit.
      const files = tasks[index].file_references ? { file_references: tasks[index].file_references } : {};
      tasks = [...tasks.slice(0, index), done(id, 20 + seq, String(request.json.task), "Mostly mice, berries and beetles.", files)];
      return { body: { id, status: "queued", topic_id: "topic-1", replaced_task_id: target, removed_task_ids: removed } };
    };
  }
  return { api, edits, tasks: () => tasks };
}

async function openTopic(runtime: ReturnType<typeof topicRuntime>, extra: Parameters<typeof openConsole>[0] = {}) {
  const { app, calls } = await openConsole({ location: CHAT, api: runtime.api, ...extra });
  await app.waitFor("Reynard, of the old fables.");
  return { app, calls };
}

test("each sent message has Edit beside Copy, which opens the quote bar with Cancel", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  // One Edit per sent message (the replies have Copy alone), each beside its Copy.
  expect(app.count("id:chat-edit")).toBe(3);
  expect(app.count("id:chat-message-actions")).toBe(3);
  expect(app.count("id:chat-message-actions >> id:chat-edit")).toBe(3);
  expect(app.count("id:chat-message-actions >> id:chat-copy")).toBe(3);
  expect(app.shows("label:Edit message")).toBe(true);

  await app.press("id:chat-edit >> nth=1");
  await app.waitFor("id:chat-composer-edit-quote");
  expect(app.value("id:chat-composer-input")).toBe("Where do foxes live?");
  expect(app.shows("id:chat-composer-edit-quote >> text:Where do foxes live?")).toBe(true);
  expect(app.shows("id:chat-composer-edit-quote >> text:EDITING")).toBe(true);
  expect(app.shows("id:chat-composer-edit-cancel")).toBe(true);
  expect(app.shows("label:Editing your message: Where do foxes live?")).toBe(true);
  // The target is marked; what the edit replaces fades: t2's reply and the whole t3 exchange.
  expect(app.count("id:chat-user-bubble.editing")).toBe(1);
  expect(app.count("id:chat-edit.editing")).toBe(1);
  expect(app.count("id:chat-item-agent.replaced")).toBe(2);
  expect(app.count("id:chat-item-user.replaced")).toBe(1);
  expect(app.shows("label:Send edited message (Enter)")).toBe(true);
  // Attaching is off while editing: an edit sends text, its message's files go with it.
  expect(runtime.edits.length).toBe(0);
});

test("sending an edit of the latest message replaces it and runs it again", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  await app.type("id:chat-composer-input", "unsent thought");
  await app.press("id:chat-edit >> nth=2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Name a famous fox");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "Name a fox from a cartoon");
  await app.press("id:chat-composer-send");
  await app.waitFor("Name a fox from a cartoon");
  await app.waitFor("Mostly mice, berries and beetles.", { timeout: 8000 });
  expect(runtime.edits).toEqual([
    {
      target: "t3",
      json: { task: "Name a fox from a cartoon", topic_id: "topic-1", trigger: { source: "ui", event: "chat_edit", ref: "web/console/chat" } },
    },
  ]);
  // The old message and its reply are gone; the earlier turns stay.
  expect(app.shows("text:Name a famous fox")).toBe(false);
  expect(app.shows("text:Reynard, of the old fables.")).toBe(false);
  expect(app.shows("text:What is a fox?")).toBe(true);
  expect(app.shows("text:Where do foxes live?")).toBe(true);
  // The edit is over: no quote bar, nothing faded, the draft back in the composer.
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
  expect(app.count("id:chat-item-agent.replaced")).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("unsent thought");
});

test("sending an edit of an earlier message drops every later turn, also after a reload", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  await app.press("id:chat-edit >> nth=1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Where do foxes live?");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "What do foxes eat?");
  await app.press("id:chat-composer-send");
  await app.waitFor("Mostly mice, berries and beetles.", { timeout: 8000 });
  expect(runtime.edits.map((edit) => edit.target)).toEqual(["t2"]);
  for (const gone of ["Where do foxes live?", "Almost everywhere: woods, fields and towns.", "Name a famous fox", "Reynard, of the old fables."]) {
    expect(app.shows(`text:${gone}`)).toBe(false);
  }
  expect(app.count("id:chat-item-user")).toBe(2);
  // The edited message keeps the file it carried; the edit's request sent no files of its own.
  await app.waitUntil(() => app.count("id:chat-user-file") === 1);
  expect(app.shows("text:fox-map.png")).toBe(true);
  expect(runtime.edits[0].json.file_references).toBe(undefined);

  // Another topic and back: the conversation loads from the runtime as stored.
  await app.press("text:Owls");
  await app.waitFor("Do owls sleep?");
  await app.press("text:Foxes");
  await app.waitFor("What do foxes eat?");
  await app.waitFor("Mostly mice, berries and beetles.");
  expect(app.shows("text:Name a famous fox")).toBe(false);
  expect(app.shows("text:Where do foxes live?")).toBe(false);
  expect(app.count("id:chat-item-user")).toBe(2);
  expect(runtime.tasks().map((task) => task.id)).toEqual(["t1", "n1"]);
  expect(app.count("id:chat-user-file")).toBe(1);
});

test("Cancel and Escape give the draft back and send nothing", async () => {
  const runtime = topicRuntime();
  const { app, calls } = await openTopic(runtime);
  await app.type("id:chat-composer-input", "half a thought");
  await app.press("id:chat-edit >> nth=0");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "What is a fox?");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "What is a red fox?");
  await app.press("id:chat-composer-edit-cancel");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
  expect(app.count("id:chat-item-agent.replaced")).toBe(0);

  // Escape in the field does the same.
  await app.press("id:chat-edit >> nth=2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Name a famous fox");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);

  expect(runtime.edits.length).toBe(0);
  expect(calls.some((call) => call.method === "POST" && String(call.uri || "").startsWith("/tasks"))).toBe(false);
  for (const kept of ["What is a fox?", "Where do foxes live?", "Name a famous fox", "Reynard, of the old fables."]) {
    expect(app.shows(`text:${kept}`)).toBe(true);
  }
});

test("Escape leaves an edit whose text ends in a path: no suggestions hold it back", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime, { api: { ...runtime.api, "GET /commands": { body: { items: [{ value: "/alpha", title: "/alpha" }] } } } });
  await app.type("id:chat-composer-input", "half a thought");
  await app.press("id:chat-edit >> nth=0");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "What is a fox?");
  await app.type("id:chat-composer-input", " see /home/fox/notes");
  await app.wait(300);
  expect(app.shows("id:chat-composer-suggestions")).toBe(false);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
  expect(runtime.edits.length).toBe(0);
});

test("Enter sends an edit whose text ends in a path, as it is", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  await app.press("id:chat-edit >> nth=2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Name a famous fox");
  await app.type("id:chat-composer-input", " in /Users/me/foxes");
  await app.wait(300);
  expect(app.shows("id:chat-composer-suggestions")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitUntil(() => runtime.edits.length === 1);
  expect(runtime.edits[0].json.task).toBe("Name a famous fox in /Users/me/foxes");
});

test("in a browser's phone layout Escape and Enter are not the edit's: Cancel leaves it, the button sends it", async () => {
  // No application shortcuts there (lib/shortcutPolicy.ts), with a hardware keyboard's keys too.
  const runtime = topicRuntime();
  const { app, calls } = await openTopic(runtime, { width: 390, height: 844 });
  await app.type("id:chat-composer-input", "half a thought");
  await app.press("id:chat-edit >> nth=0");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "What is a fox?");
  expect(app.shows("label:Send edited message")).toBe(true);
  expect(app.shows("label:Send edited message (Enter)")).toBe(false);
  await app.keyboard.press("escape");
  await app.keyboard.press("enter");
  await app.wait(300);
  expect(app.shows("id:chat-composer-edit-quote")).toBe(true);
  expect(runtime.edits.length).toBe(0);
  expect(calls.some((call) => call.method === "POST" && String(call.uri || "").startsWith("/tasks"))).toBe(false);
  await app.press("id:chat-composer-edit-cancel");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
});

test("an empty edit cannot be sent", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  await app.press("id:chat-edit >> nth=1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Where do foxes live?");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "   ");
  await app.waitUntil(() => !app.enabled("id:chat-composer-send"));
  await app.submit("id:chat-composer-input");
  await app.wait(200);
  expect(runtime.edits.length).toBe(0);
  expect(app.shows("id:chat-composer-edit-quote")).toBe(true);
  expect(app.shows("text:Name a famous fox")).toBe(true);
});

test("a refused edit keeps the conversation and the edited text for another try", async () => {
  let refusals = 1;
  const runtime = topicRuntime({
    refuse: () =>
      refusals-- > 0 ? { status: 409, body: { error: "a reply in this topic is still under way; wait for it to finish or stop it before editing a message" } } : null,
  });
  const { app } = await openTopic(runtime);
  await app.type("id:chat-composer-input", "my draft");
  await app.press("id:chat-edit >> nth=1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Where do foxes live?");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "What do foxes eat?");
  await app.press("id:chat-composer-send");
  await app.waitFor("text:/still under way/");
  // Nothing changed on screen, and the edit is still open with its text.
  for (const kept of ["Where do foxes live?", "Name a famous fox", "Reynard, of the old fables."]) {
    expect(app.shows(`text:${kept}`)).toBe(true);
  }
  expect(app.value("id:chat-composer-input")).toBe("What do foxes eat?");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(true);
  expect(app.count("id:chat-user-bubble.editing")).toBe(1);

  // Sent again (Enter: the error's notice lies over Send), it goes through.
  await app.submit("id:chat-composer-input");
  await app.waitFor("Mostly mice, berries and beetles.", { timeout: 8000 });
  expect(runtime.edits.map((edit) => edit.target)).toEqual(["t2", "t2"]);
  expect(app.shows("text:Name a famous fox")).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("my draft");
});

test("an edit whose message is already gone ends once the conversation reloads", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  await app.type("id:chat-composer-input", "my draft");
  await app.press("id:chat-edit >> nth=2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Name a famous fox");
  // Another device edited t2 meanwhile: t3 is gone from the runtime.
  runtime.api["POST /proxy:/tasks/t2/replace"]({ json: { task: "Elsewhere" }, uri: "/tasks/t2/replace" } as ApiRequest);
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "Name a fox from a song");
  await app.press("id:chat-composer-send");
  await app.waitFor("text:/message not found/");
  await app.waitFor("Elsewhere");
  expect(app.shows("text:Name a famous fox")).toBe(false);
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("my draft");
});

test("nothing can be edited while a reply runs", async () => {
  const runtime = topicRuntime({ running: true });
  const { app } = await openConsole({ location: CHAT, api: runtime.api });
  await app.waitFor("And their tails?");
  expect(app.count("id:chat-edit")).toBe(0);
  expect(app.shows("label:Edit message")).toBe(false);
});

test("leaving the topic while editing gives each topic its own draft back", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime);
  await app.type("id:chat-composer-input", "fox draft");
  await app.press("id:chat-edit >> nth=1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Where do foxes live?");
  await app.clear("id:chat-composer-input");
  await app.type("id:chat-composer-input", "edited, never sent");
  await app.press("text:Owls");
  await app.waitFor("Do owls sleep?");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("");
  await app.press("text:Foxes");
  await app.waitFor("Reynard, of the old fables.");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "fox draft");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(false);
  expect(app.shows("text:edited, never sent")).toBe(false);
  expect(runtime.edits.length).toBe(0);
});

test("a long message is quoted on one line", async () => {
  const long = `${"A very long question about foxes and their habits ".repeat(12)}\nwith a second line`;
  const runtime = topicRuntime();
  runtime.tasks()[2].task = long;
  const { app } = await openTopic(runtime);
  await app.press("id:chat-edit >> nth=2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === long);
  // The quote is the message on one line (line breaks become spaces); the bar cuts it to its width.
  const line = long.trim().replace(/\s+/g, " ");
  expect(app.shows(`id:chat-composer-edit-quote >> text:${line}`)).toBe(true);
  expect(app.shows("id:chat-composer-edit-cancel")).toBe(true);
});

test("on a phone, Edit and the quote bar work the same", async () => {
  const runtime = topicRuntime();
  const { app } = await openTopic(runtime, { platform: "android", width: 390, height: 844 });
  // Touch screens have no hover: Edit and Copy always show.
  expect(app.count("id:chat-edit")).toBe(3);
  await app.press("id:chat-edit >> nth=0");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "What is a fox?");
  expect(app.shows("id:chat-composer-edit-quote")).toBe(true);
  expect(app.shows("label:Send edited message")).toBe(true);
  await app.press("id:chat-composer-edit-cancel");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "");
  expect(runtime.edits.length).toBe(0);
});
