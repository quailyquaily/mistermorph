// The rename dialog's field lets go when the dialog closes (components/shared/dialogFieldFocus.ts),
// driven here by the dialog's own state (pages/chat/topicRename.ts) with a stand-in field, keyboard
// and turn: headless runs settle the closing motion before the next step, so whether the field of
// a dialog going out still has the focus can't be seen on the page. Every closing (Cancel and the
// other ways the dialog asks to close, a save, the page closing it, the page going) blurs the field
// and lowers the keyboard once; a save under way, a failed save and a blank one keep the dialog and
// its focus; each opening focuses the field a turn later, and an opening already gone, or a late
// answer of an older one, never moves the focus of a newer one.
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

function setup() {
  const log: string[] = [];
  const turns: (() => void)[] = [];
  const saves: ReturnType<typeof deferred<any>>[] = [];
  const mounted = signal(true);
  let rename!: TopicRename;
  // The field the dialog mounts, as nsh hands it to `inputRef`.
  const field = (name: string) =>
    ({
      focus: () => log.push(`focus ${name}`),
      blur: () => log.push(`blur ${name}`),
      measure: async () => null,
      setSelection: () => {},
    }) as unknown as InputRef;
  effect(() => {
    untracked(() => {
      rename = createTopicRename({
        suggest: async () => ({ title: "Suggested" }),
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
      });
      focus.ref(field("first"));
    });
  });
  const nextTurn = () => turns.splice(0).forEach((fn) => fn());
  const open = (topicID = "topic-1") => rename.start({ endpointRef: "ep", topicID, title: "Trip plans" });
  return { log, turns, saves, mounted, rename: () => rename, field, mount: (name: string) => focus?.ref(field(name)), nextTurn, open };
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
