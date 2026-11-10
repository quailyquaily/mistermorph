// The topic rename dialog's state (pages/chat/topicRename.ts) on suggestions and saves the test
// answers, so they can come late: a suggestion lands only in the dialog that asked and never over
// an edit made since; a save that fails keeps the draft; closing saves nothing.
import { expect, test } from "nsh/test";
import { effect, untracked } from "nsh";
import { createTopicRename, normalizeTopicTitleDraft, type TopicRename } from "../pages/chat/topicRename";

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const suggestions: { endpointRef: string; topicID: string; answer: ReturnType<typeof deferred<any>> }[] = [];
  const saves: { endpointRef: string; topicID: string; title: string; answer: ReturnType<typeof deferred<any>> }[] = [];
  const saved: { topicID: string; topic: any }[] = [];
  let rename!: TopicRename;
  effect(() => {
    untracked(() => {
      rename = createTopicRename({
        suggest: (endpointRef, topicID) => {
          const answer = deferred<any>();
          suggestions.push({ endpointRef, topicID, answer });
          return answer.promise;
        },
        save: (endpointRef, topicID, title) => {
          const answer = deferred<any>();
          saves.push({ endpointRef, topicID, title, answer });
          return answer.promise;
        },
        onSaved: (session, topic) => saved.push({ topicID: session.topicID, topic }),
        messages: () => ({ empty: "Enter a topic name.", saveFailed: "Could not rename.", suggestFailed: "Could not suggest." }),
      });
    });
  });
  return { rename, suggestions, saves, saved };
}

test("the dialog opens with the stored title, and a save sends the trimmed draft", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  expect(t.rename.open()).toBe(true);
  expect(t.rename.draft()).toBe("Trip plans");
  t.rename.setDraft("  Lisbon\n  trip ");
  void t.rename.save();
  expect(t.saves.map((save) => save.title)).toEqual(["Lisbon trip"]);
  expect(t.rename.saving()).toBe(true);
  // A second press while it saves sends nothing more, and the dialog stays.
  void t.rename.save();
  t.rename.close();
  expect(t.saves.length).toBe(1);
  expect(t.rename.open()).toBe(true);
  t.saves[0].answer.resolve({ id: "topic-1", title: "Lisbon trip", title_revision: 3 });
  await settle();
  expect(t.saved).toEqual([{ topicID: "topic-1", topic: { id: "topic-1", title: "Lisbon trip", title_revision: 3 } }]);
  expect(t.rename.open()).toBe(false);
});

test("a blank draft is not saved, and a topic without a title starts empty", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "" });
  expect(t.rename.draft()).toBe("");
  expect(t.rename.saveDisabled()).toBe(true);
  await t.rename.save();
  expect(t.rename.error()).toBe("Enter a topic name.");
  t.rename.setDraft(" \n\t ");
  expect(t.rename.error()).toBe("");
  expect(t.rename.saveDisabled()).toBe(true);
  await t.rename.save();
  expect(t.saves.length).toBe(0);
  expect(t.rename.open()).toBe(true);
  expect(normalizeTopicTitleDraft("  a \n b ")).toBe("a b");
});

test("a failed save keeps the draft and says why, and a retry can succeed", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  t.rename.setDraft("Mine");
  void t.rename.save();
  t.saves[0].answer.reject(new Error("store is down"));
  await settle();
  expect(t.rename.open()).toBe(true);
  expect(t.rename.saving()).toBe(false);
  expect(t.rename.draft()).toBe("Mine");
  expect(t.rename.error()).toBe("store is down");
  expect(t.saved.length).toBe(0);
  void t.rename.save();
  expect(t.rename.error()).toBe("");
  t.saves[1].answer.resolve({ id: "topic-1", title: "Mine" });
  await settle();
  expect(t.rename.open()).toBe(false);
});

test("Regenerate puts the suggestion in the draft, which can be edited and saved", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Where to go?" });
  void t.rename.regenerate();
  void t.rename.regenerate();
  expect(t.suggestions.length).toBe(1);
  expect(t.rename.suggesting()).toBe(true);
  // No save while a suggestion is under way.
  expect(t.rename.saveDisabled()).toBe(true);
  void t.rename.save();
  expect(t.saves.length).toBe(0);
  t.suggestions[0].answer.resolve({ title: "Lisbon trip", icon: "airplane" });
  await settle();
  expect(t.rename.suggesting()).toBe(false);
  expect(t.rename.draft()).toBe("Lisbon trip");
  t.rename.setDraft("Lisbon trip in May");
  void t.rename.save();
  expect(t.saves.map((save) => [save.topicID, save.title])).toEqual([["topic-1", "Lisbon trip in May"]]);
});

test("a failed suggestion keeps the draft and says why", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  t.rename.setDraft("Half typed");
  void t.rename.regenerate();
  t.suggestions[0].answer.reject(new Error("offline"));
  await settle();
  expect(t.rename.draft()).toBe("Half typed");
  expect(t.rename.error()).toBe("offline");
  expect(t.rename.suggesting()).toBe(false);
  // An empty suggestion is a failure too.
  void t.rename.regenerate();
  t.suggestions[1].answer.resolve({ title: "  " });
  await settle();
  expect(t.rename.draft()).toBe("Half typed");
  expect(t.rename.error()).toBe("Could not suggest.");
});

test("a suggestion that answers after an edit leaves the edit", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  void t.rename.regenerate();
  t.rename.setDraft("Typed meanwhile");
  t.suggestions[0].answer.resolve({ title: "Generated" });
  await settle();
  expect(t.rename.draft()).toBe("Typed meanwhile");
  expect(t.rename.suggesting()).toBe(false);
  expect(t.rename.error()).toBe("");
});

test("a late suggestion or save never reaches another dialog", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  void t.rename.regenerate();
  // Cancel, then rename another topic: the first suggestion answers into nothing.
  t.rename.close();
  expect(t.rename.open()).toBe(false);
  t.rename.start({ endpointRef: "ep", topicID: "topic-2", title: "Recipes" });
  expect(t.rename.suggesting()).toBe(false);
  t.suggestions[0].answer.resolve({ title: "Generated for topic 1" });
  await settle();
  expect(t.rename.draft()).toBe("Recipes");
  // Reopening the same topic is a new dialog too.
  void t.rename.regenerate();
  t.rename.close();
  t.rename.start({ endpointRef: "ep", topicID: "topic-2", title: "Recipes" });
  t.suggestions[1].answer.reject(new Error("late failure"));
  await settle();
  expect(t.rename.error()).toBe("");
  expect(t.rename.suggesting()).toBe(false);
  // A save the page cut short (the topic went) still reports what was stored, but leaves the
  // dialog that came after it alone.
  t.rename.setDraft("Soups");
  void t.rename.save();
  t.rename.close({ force: true });
  t.rename.start({ endpointRef: "ep2", topicID: "topic-9", title: "Other" });
  t.saves[0].answer.resolve({ id: "topic-2", title: "Soups" });
  await settle();
  expect(t.saved.map((entry) => entry.topicID)).toEqual(["topic-2"]);
  expect(t.rename.open()).toBe(true);
  expect(t.rename.session()?.topicID).toBe("topic-9");
  expect(t.rename.draft()).toBe("Other");
  expect(t.rename.saving()).toBe(false);
  // Its failure would not reach it either.
  t.rename.setDraft("Other two");
  void t.rename.save();
  t.rename.close({ force: true });
  t.rename.start({ endpointRef: "ep2", topicID: "topic-9", title: "Other" });
  t.saves[1].answer.reject(new Error("too late"));
  await settle();
  expect(t.rename.error()).toBe("");
  expect(t.rename.draft()).toBe("Other");
});

test("closing saves nothing", async () => {
  const t = setup();
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  t.rename.setDraft("Never saved");
  t.rename.close();
  expect(t.rename.open()).toBe(false);
  expect(t.saves.length).toBe(0);
  t.rename.start({ endpointRef: "ep", topicID: "topic-1", title: "Trip plans" });
  expect(t.rename.draft()).toBe("Trip plans");
});
