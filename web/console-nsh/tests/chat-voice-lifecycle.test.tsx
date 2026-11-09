// The recording host's voice input (components/chat/voice.ts) on a recorder the test plays, so
// answers can come late: what an older recording brings never reaches the draft or ends a newer
// one. Switching the conversation (`scope`) and the host ending a recording (the phone app left the
// foreground, the recorder failed) throw away what is under way; nothing heard leaves the draft.
import { expect, test } from "nsh/test";
import { effect, signal, untracked } from "nsh";
import type { PickedFile } from "../lib/platform";
import { createVoiceInput, type VoiceInput, type VoiceRecorder } from "../components/chat/voice";

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

const FILE = (id: string): PickedFile => ({ id, name: "voice.m4a", size: 10, type: "audio/mp4", preview: "" });

/** A recorder whose starts, stops and transcriptions the test answers, and a voice input on it. */
function setup() {
  const starts: ReturnType<typeof deferred<{ ok: boolean; error?: string; message?: string }>>[] = [];
  const stops: ReturnType<typeof deferred<PickedFile | null>>[] = [];
  const transcriptions: ReturnType<typeof deferred<string>>[] = [];
  const ended = new Set<(ended: { reason: string; message: string }) => void>();
  const log: string[] = [];
  const recorder: VoiceRecorder = {
    available: () => true,
    previews: () => false,
    support: async () => "",
    start: () => {
      log.push("start");
      const next = deferred<{ ok: boolean; error?: string; message?: string }>();
      starts.push(next);
      return next.promise;
    },
    stop: () => {
      log.push("stop");
      const next = deferred<PickedFile | null>();
      stops.push(next);
      return next.promise;
    },
    cancel: () => {
      log.push("cancel");
    },
    onPreview: () => () => {},
    onEnded: (listener) => {
      ended.add(listener);
      return () => ended.delete(listener);
    },
  };
  const scope = signal("ep\ntopic-1");
  const texts: string[] = [];
  const errors: { code: string; message?: string }[] = [];
  let voice!: VoiceInput;
  effect(() => {
    untracked(() => {
      voice = createVoiceInput({
        recorder,
        endpointRef: () => "ep",
        scope: () => scope(),
        canTranscribe: async () => true,
        transcribe: (_ref, file) => {
          log.push(`transcribe ${file.id}`);
          const next = deferred<string>();
          transcriptions.push(next);
          return next.promise;
        },
        release: (file) => log.push(`release ${file.id}`),
        onText: (text) => texts.push(text),
        onError: (error) => errors.push(error),
      });
    });
  });
  const end = (reason: string, message = "") => {
    for (const listener of [...ended]) listener({ reason, message });
  };
  return { voice, starts, stops, transcriptions, log, scope, texts, errors, end };
}

/** Starts a recording the recorder accepted. */
async function recording(t: ReturnType<typeof setup>) {
  t.voice.toggle();
  expect(t.voice.state()).toBe("recording");
  t.starts.at(-1)!.resolve({ ok: true });
  await settle();
}

test("the mic waits for the route, and a finished recording goes into the draft", async () => {
  const t = setup();
  await settle();
  expect(t.voice.available()).toBe(true);
  await recording(t);
  t.voice.toggle();
  expect(t.voice.state()).toBe("transcribing");
  t.stops[0].resolve(FILE("v1"));
  await settle();
  t.transcriptions[0].resolve("book a table");
  await settle();
  expect(t.texts).toEqual(["book a table"]);
  expect(t.voice.state()).toBe("idle");
  expect(t.log).toEqual(["start", "stop", "transcribe v1", "release v1"]);
});

test("nothing heard leaves the draft alone and the mic idle", async () => {
  const t = setup();
  await settle();
  await recording(t);
  t.voice.toggle();
  t.stops[0].resolve(FILE("v1"));
  await settle();
  t.transcriptions[0].resolve("");
  await settle();
  expect(t.texts).toEqual([]);
  expect(t.errors).toEqual([]);
  expect(t.voice.state()).toBe("idle");
  expect(t.log.at(-1)).toBe("release v1");
});

test("another conversation throws the transcription away, and its late answer neither lands nor ends the next one", async () => {
  const t = setup();
  await settle();
  await recording(t);
  t.voice.toggle();
  t.stops[0].resolve(FILE("v1"));
  await settle();
  expect(t.voice.state()).toBe("transcribing");
  t.scope.set("ep\ntopic-2");
  expect(t.voice.state()).toBe("idle");
  expect(t.log.at(-1)).toBe("cancel");
  // A recording in the other conversation, then the first answer comes.
  await recording(t);
  t.transcriptions[0].resolve("first take");
  await settle();
  expect(t.texts).toEqual([]);
  expect(t.voice.state()).toBe("recording");
  t.voice.toggle();
  t.stops[1].resolve(FILE("v2"));
  await settle();
  t.transcriptions[1].resolve("second take");
  await settle();
  expect(t.texts).toEqual(["second take"]);
  // The first recording's file was still released.
  expect(t.log.filter((entry) => entry.startsWith("release"))).toEqual(["release v1", "release v2"]);
});

test("another conversation ends a recording under way; a failure after it is not shown", async () => {
  const t = setup();
  await settle();
  await recording(t);
  t.scope.set("ep\ntopic-2");
  expect(t.voice.state()).toBe("idle");
  expect(t.log).toEqual(["start", "cancel"]);
  // The same agent and topic again: nothing changes.
  t.scope.set("ep\ntopic-2");
  expect(t.log).toEqual(["start", "cancel"]);

  await recording(t);
  t.voice.toggle();
  t.scope.set("other\ntopic-2");
  t.stops[0].reject(new Error("HTTP 502"));
  await settle();
  expect(t.errors).toEqual([]);
  expect(t.voice.state()).toBe("idle");
});

test("the host ending the recording: leaving says nothing, a recorder failure says why", async () => {
  const t = setup();
  await settle();
  await recording(t);
  t.end("background");
  expect(t.voice.state()).toBe("idle");
  expect(t.errors).toEqual([]);
  // Leaving while transcribing: the host aborted the upload; its rejection is not shown.
  await recording(t);
  t.voice.toggle();
  t.stops[0].resolve(FILE("v1"));
  await settle();
  t.end("background");
  expect(t.voice.state()).toBe("idle");
  t.transcriptions[0].reject(new Error("The recording was discarded."));
  await settle();
  expect(t.errors).toEqual([]);
  expect(t.texts).toEqual([]);
  // A recorder failure.
  await recording(t);
  t.end("error", "The recorder stopped (1, -1).");
  expect(t.voice.state()).toBe("idle");
  expect(t.errors).toEqual([{ code: "failed", message: "The recorder stopped (1, -1)." }]);
  // An end while idle changes nothing.
  t.end("background");
  expect(t.errors.length).toBe(1);
});

test("a start the host cancelled is no error; a refused one says why; a late grant is let go", async () => {
  const t = setup();
  await settle();
  t.voice.toggle();
  t.starts[0].resolve({ ok: false, error: "cancelled" });
  await settle();
  expect(t.voice.state()).toBe("idle");
  expect(t.errors).toEqual([]);

  t.voice.toggle();
  t.starts[1].resolve({ ok: false, error: "permission-denied" });
  await settle();
  expect(t.errors).toEqual([{ code: "permission-denied", message: undefined }]);

  // Left while the system asked: the start that still says yes is cancelled at once.
  t.voice.toggle();
  t.end("background");
  expect(t.voice.state()).toBe("idle");
  t.starts[2].resolve({ ok: true });
  await settle();
  expect(t.voice.state()).toBe("idle");
  expect(t.log.slice(-2)).toEqual(["start", "cancel"]);
});

// The host records one at a time and `cancel` ends whichever it records. A start cancelled before
// the host answered is let go (cancelled) when its yes comes; a newer start waits for that, so the
// letting go cannot end the newer recording.
test("a cancelled start's late yes is let go before the next recording starts, never ending it", async () => {
  const t = setup();
  await settle();
  t.voice.toggle();
  expect(t.log).toEqual(["start"]);
  t.voice.cancel();
  expect(t.voice.state()).toBe("idle");
  expect(t.log).toEqual(["start", "cancel"]);

  // A new recording while the first start is still unanswered: it waits for that answer.
  t.voice.toggle();
  expect(t.voice.state()).toBe("recording");
  await settle();
  expect(t.log).toEqual(["start", "cancel"]);

  // The first start's late yes is let go, and only then does the new one start.
  t.starts[0].resolve({ ok: true });
  await settle();
  expect(t.log).toEqual(["start", "cancel", "cancel", "start"]);
  t.starts[1].resolve({ ok: true });
  await settle();
  expect(t.voice.state()).toBe("recording");
  expect(t.log).toEqual(["start", "cancel", "cancel", "start"]);

  // It records, and is stopped and transcribed as usual.
  t.voice.toggle();
  t.stops[0].resolve(FILE("v2"));
  await settle();
  t.transcriptions[0].resolve("second take");
  await settle();
  expect(t.texts).toEqual(["second take"]);
  expect(t.errors).toEqual([]);
  expect(t.voice.state()).toBe("idle");
});

test("recordings started and cancelled while an old start is unanswered: only the last one starts", async () => {
  const t = setup();
  await settle();
  t.voice.toggle();
  t.voice.cancel();
  // B, cancelled while it waits for the first start's answer, never reaches the host.
  t.voice.toggle();
  t.voice.cancel();
  t.voice.toggle();
  expect(t.voice.state()).toBe("recording");
  t.starts[0].resolve({ ok: false, error: "cancelled" });
  await settle();
  expect(t.log.filter((entry) => entry === "start").length).toBe(2);
  t.starts[1].resolve({ ok: true });
  await settle();
  expect(t.voice.state()).toBe("recording");
  expect(t.log.at(-1)).toBe("start");
  expect(t.errors).toEqual([]);
});
