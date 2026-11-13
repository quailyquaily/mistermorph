// The rename dialog's field lets go when the dialog closes (components/shared/dialogFieldFocus.ts),
// driven here by the dialog's own state (pages/chat/topicRename.ts) with a stand-in field, keyboard
// and turn: headless runs settle the closing motion before the next step, so whether the field of
// a dialog going out still has the focus can't be seen on the page. Every closing (Cancel and the
// other ways the dialog asks to close, a save, the page closing it, the page going) blurs the field
// and lowers the keyboard once; a save under way, a failed save and a blank one keep the dialog and
// its focus; each opening focuses the field a turn later, and an opening already gone, or a late
// answer of an older one, never moves the focus of a newer one.
//
// The rename dialog also selects the current name as each opening focuses the field
// (`selectOnOpen`), so typing replaces it: on a first opening, on a dialog mounted already open,
// on a reopening (the same field or one mounted anew) and on another topic's. Editing, a generated
// name and a failed save never select again; a turn of an opening already gone selects nothing.
// Headless inputs ignore `setSelection`, so the stand-in field records it.
import { expect, test } from "nsh/test";
import { effect, signal, untracked, type InputRef } from "nsh";
import { createDialogFieldFocus } from "../components/shared/dialogFieldFocus";
import { createTopicRename, type TopicRename } from "../pages/chat/topicRename";

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

function setup(options: { select?: boolean; mounted?: boolean; fieldOnMount?: boolean } = {}) {
  const log: string[] = [];
  const turns: (() => void)[] = [];
  const saves: ReturnType<typeof deferred<any>>[] = [];
  const mounted = signal(options.mounted ?? true);
  let rename!: TopicRename;
  // The field the dialog mounts, as nsh hands it to `inputRef`.
  const field = (name: string) =>
    ({
      focus: () => log.push(`focus ${name}`),
      blur: () => log.push(`blur ${name}`),
      measure: async () => null,
      setSelection: (start: number, end: number) => log.push(`select ${name} ${start}-${end}`),
    }) as unknown as InputRef;
  const suggestions: ReturnType<typeof deferred<any>>[] = [];
  effect(() => {
    untracked(() => {
      rename = createTopicRename({
        suggest: () => {
          const answer = deferred<any>();
          suggestions.push(answer);
          return answer.promise;
        },
        save: () => {
          const answer = deferred<any>();
          saves.push(answer);
          return answer.promise;
        },
        messages: () => ({ empty: "Enter a topic name.", saveFailed: "Could not rename.", suggestFailed: "Could not suggest." }),
      });
    });
  });
  let focus: ReturnType<typeof createDialogFieldFocus> | null = null;
  // The dialog's component: mounted while `mounted` is true.
  effect(() => {
    if (!mounted()) return;
    untracked(() => {
      focus = createDialogFieldFocus({
        session: () => rename.session(),
        dismissKeyboard: () => log.push("keyboard down"),
        defer: (fn) => turns.push(fn),
        selectOnOpen: options.select ? () => rename.draft() : undefined,
      });
      if (options.fieldOnMount !== false) focus.ref(field("first"));
    });
  });
  const nextTurn = () => turns.splice(0).forEach((fn) => fn());
  const open = (topicID = "topic-1", title = "Trip plans") => rename.start({ endpointRef: "ep", topicID, title });
  return {
    log,
    turns,
    saves,
    suggestions,
    mounted,
    rename: () => rename,
    field,
    mount: (name: string) => focus?.ref(field(name)),
    nextTurn,
    open,
  };
}

test("Cancel (and every other ask to close) blurs the field and lowers the keyboard once", async () => {
  const s = setup();
  s.open();
  s.nextTurn();
  expect(s.log).toEqual(["focus first"]);
  s.rename().close();
  expect(s.rename().open()).toBe(false);
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);
  // A second ask (the scrim pressed while the dialog goes out) changes nothing more.
  s.rename().close();
  s.nextTurn();
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);
});

test("a successful save, Enter's included, blurs the field once it closes the dialog", async () => {
  const s = setup();
  s.open();
  s.nextTurn();
  s.rename().setDraft("Lisbon");
  void s.rename().save();
  // Saving: the dialog stays, and so do the focus and the keyboard; ordinary closes are held.
  s.rename().close();
  expect(s.rename().open()).toBe(true);
  expect(s.log).toEqual(["focus first"]);
  s.saves[0].resolve({ id: "topic-1", title: "Lisbon" });
  await settle();
  expect(s.rename().open()).toBe(false);
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);
});

test("a failed save and a blank one keep the dialog, its error and the focus", async () => {
  const s = setup();
  s.open();
  s.nextTurn();
  s.rename().setDraft("   ");
  await s.rename().save();
  expect(s.rename().error()).toBe("Enter a topic name.");
  s.rename().setDraft("Lisbon");
  void s.rename().save();
  s.saves[0].reject(new Error("store is down"));
  await settle();
  expect(s.rename().open()).toBe(true);
  expect(s.rename().error()).toBe("store is down");
  expect(s.rename().draft()).toBe("Lisbon");
  expect(s.log).toEqual(["focus first"]);
  // Still usable: a retry that works closes it and lets go.
  void s.rename().save();
  s.saves[1].resolve({ id: "topic-1", title: "Lisbon" });
  await settle();
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);
});

test("the page closing the dialog (topic or runtime changed) lets go, even during a save", async () => {
  const s = setup();
  s.open();
  s.nextTurn();
  void s.rename().save();
  s.rename().close({ force: true });
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);
});

test("a reopened dialog focuses its field again; an opening gone before its turn focuses nothing", async () => {
  const s = setup();
  s.open();
  s.rename().close();
  // Closed before the turn came: no focus.
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down"]);
  // Reopened while it still went out: the same field, focused again.
  s.open();
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down", "focus first"]);
  s.rename().close();
  // Gone and mounted anew: the new field is the one focused.
  s.open("topic-2");
  s.mount("second");
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down", "focus first", "blur first", "keyboard down", "focus second"]);
});

test("a late save of an older opening never blurs a newer one", async () => {
  const s = setup();
  s.open("topic-1");
  s.nextTurn();
  void s.rename().save();
  // The topic changed under the save; then a rename of the next topic opened.
  s.rename().close({ force: true });
  s.open("topic-2");
  s.nextTurn();
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down", "focus first"]);
  s.saves[0].resolve({ id: "topic-1", title: "Trip plans" });
  await settle();
  expect(s.rename().open()).toBe(true);
  expect(s.rename().session()?.topicID).toBe("topic-2");
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down", "focus first"]);
});

test("a dialog that goes with its page while open lets go; one already closed does nothing more", async () => {
  const s = setup();
  s.open();
  s.nextTurn();
  s.mounted.set(false);
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);
  // Its state closing later reaches no field.
  s.rename().close({ force: true });
  expect(s.log).toEqual(["focus first", "blur first", "keyboard down"]);

  const closed = setup();
  closed.open();
  closed.rename().close();
  closed.mounted.set(false);
  expect(closed.log).toEqual(["blur first", "keyboard down"]);
});

test("selecting: an opening focuses the field and selects the whole current name, once", async () => {
  const s = setup({ select: true });
  s.open();
  // Nothing before the turn: the field and the opening settle first.
  expect(s.log).toEqual([]);
  s.nextTurn();
  // "Trip plans" is 10 UTF-16 units; the focus comes first, so the selection is the field's own.
  expect(s.log).toEqual(["focus first", "select first 0-10"]);
  s.nextTurn();
  expect(s.log).toEqual(["focus first", "select first 0-10"]);
});

test("selecting: a dialog mounted with its opening already on screen selects the name too", async () => {
  const s = setup({ select: true, mounted: false });
  s.open();
  s.nextTurn();
  expect(s.log).toEqual([]);
  // Mounting creates the helper with the opening there, then hands it the field.
  s.mounted.set(true);
  expect(s.log).toEqual([]);
  s.nextTurn();
  expect(s.log).toEqual(["focus first", "select first 0-10"]);
  // It is still one opening: nothing more on later turns.
  s.nextTurn();
  expect(s.log).toEqual(["focus first", "select first 0-10"]);
});

test("selecting: reopening, with the field kept or mounted anew, and another topic select again", async () => {
  const s = setup({ select: true });
  s.open();
  s.nextTurn();
  s.rename().setDraft("Trip plans 2026");
  s.rename().close();
  // Reopened while it still went out: the same field, the stored name selected again (not the
  // abandoned draft).
  s.open();
  s.nextTurn();
  expect(s.log).toEqual(["focus first", "select first 0-10", "blur first", "keyboard down", "focus first", "select first 0-10"]);
  s.log.length = 0;
  s.rename().close();
  // Another topic, its dialog drawn anew: the new field takes the new name.
  s.open("topic-2", "Recipes");
  s.mount("second");
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down", "focus second", "select second 0-7"]);
  s.log.length = 0;
  s.rename().close();
  // Units are UTF-16, as the platforms count them: an emoji is two.
  s.open("topic-3", "Café 🍲");
  s.nextTurn();
  expect(s.log).toEqual(["blur second", "keyboard down", "focus second", "select second 0-7"]);
  s.log.length = 0;
  s.rename().close();
  // A topic without a name: focused, an empty selection (a caret), nothing to replace.
  s.open("topic-4", "");
  s.nextTurn();
  expect(s.log).toEqual(["blur second", "keyboard down", "focus second", "select second 0-0"]);
});

test("selecting: a field mounted after its opening's turn is focused and selected on its own turn", async () => {
  const s = setup({ select: true, fieldOnMount: false });
  // Opened with no field yet (the dialog's content still to be drawn): its turn finds none.
  s.open("topic-2", "Recipes");
  s.nextTurn();
  expect(s.log).toEqual([]);
  // The field comes: its own turn focuses and selects it, once.
  s.mount("second");
  expect(s.log).toEqual([]);
  s.nextTurn();
  s.nextTurn();
  expect(s.log).toEqual(["focus second", "select second 0-7"]);
});

test("selecting: editing, a generated name and failed or blank saves never select again", async () => {
  const s = setup({ select: true });
  s.open();
  s.nextTurn();
  const opened = ["focus first", "select first 0-10"];
  s.rename().setDraft("Lisbon");
  s.nextTurn();
  void s.rename().regenerate();
  s.suggestions[0].resolve({ title: "Lisbon trip" });
  await settle();
  s.nextTurn();
  expect(s.rename().draft()).toBe("Lisbon trip");
  s.rename().setDraft("   ");
  await s.rename().save();
  expect(s.rename().error()).toBe("Enter a topic name.");
  s.rename().setDraft("Lisbon in May");
  void s.rename().save();
  s.saves[0].reject(new Error("store is down"));
  await settle();
  s.nextTurn();
  expect(s.rename().open()).toBe(true);
  expect(s.rename().draft()).toBe("Lisbon in May");
  expect(s.log).toEqual(opened);
  // A field handed over mid-edit (the dialog drawn anew) is not selected: the opening was.
  s.mount("first");
  s.nextTurn();
  expect(s.log).toEqual(opened);
  // Save still saves what was typed, and closes and lets go.
  void s.rename().save();
  s.saves[1].resolve({ id: "topic-1", title: "Lisbon in May" });
  await settle();
  expect(s.rename().open()).toBe(false);
  expect(s.log).toEqual([...opened, "blur first", "keyboard down"]);
});

test("selecting: a turn of an opening already gone neither focuses nor selects a newer one", async () => {
  const s = setup({ select: true });
  s.open("topic-1", "Trip plans");
  s.rename().close();
  // Reopened on another topic before the first opening's turn came: both turns run now.
  s.open("topic-2", "Recipes");
  expect(s.turns.length).toBe(2);
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down", "focus first", "select first 0-7"]);
  s.rename().close();
  s.log.length = 0;
  // Closed before its turn: nothing at all, and Cancel still lets go only once.
  s.open("topic-1", "Trip plans");
  s.rename().close();
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down"]);
  // The page going before a turn: nothing either.
  s.log.length = 0;
  s.open("topic-1", "Trip plans");
  s.mounted.set(false);
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down"]);
});

test("selecting: Cancel and Enter's save keep working as before", async () => {
  const s = setup({ select: true });
  s.open();
  s.nextTurn();
  s.rename().close();
  expect(s.rename().open()).toBe(false);
  expect(s.saves.length).toBe(0);
  expect(s.log).toEqual(["focus first", "select first 0-10", "blur first", "keyboard down"]);
  s.log.length = 0;
  s.open();
  s.nextTurn();
  // Typing over the selection replaced the name; Enter saves it.
  s.rename().setDraft("Lisbon");
  void s.rename().save();
  s.saves[0].resolve({ id: "topic-1", title: "Lisbon" });
  await settle();
  expect(s.rename().open()).toBe(false);
  expect(s.log).toEqual(["focus first", "select first 0-10", "blur first", "keyboard down"]);
});

test("without selectOnOpen a dialog never selects, and one mounted already open leaves the focus to autoFocus", async () => {
  const s = setup({ mounted: false });
  s.open();
  s.mounted.set(true);
  s.nextTurn();
  expect(s.log).toEqual([]);
  s.rename().close();
  s.open();
  s.nextTurn();
  expect(s.log).toEqual(["blur first", "keyboard down", "focus first"]);
});
