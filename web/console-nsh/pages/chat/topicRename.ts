// The topic rename dialog's state: the draft a person edits, a generated suggestion they can put in
// it (Regenerate), and the save, which alone names the topic. A suggestion is only a draft: the
// runtime saves nothing for it (POST /topics/{id}/title-suggestion), so closing the dialog leaves
// the stored title as it was.
//
// Each opening is a session of its own. A suggestion or a save that answers late lands only in the
// session that asked, and a suggestion only while the draft is still the one it would replace: an
// edit made while it was being generated wins. The page closes the session when the topic or the
// runtime changes under it.
import { batch, signal, untracked } from "nsh";

/** The longest title the runtime takes (daemonruntime.TopicTitleMaxRunes). */
export const TOPIC_TITLE_MAX_LENGTH = 72;

export interface TopicRenameTarget {
  endpointRef: string;
  topicID: string;
  /** The stored title, empty for a topic that has none yet. */
  title: string;
}

export interface TopicRenameSession extends TopicRenameTarget {
  readonly seq: number;
}

export interface TopicRenameDeps {
  /** Generates a title for the topic; resolves to the runtime's `{ title, icon }`. */
  suggest: (endpointRef: string, topicID: string) => Promise<any>;
  /** Saves the title; resolves to the renamed topic. */
  save: (endpointRef: string, topicID: string, title: string) => Promise<any>;
  /** A save succeeded: the page puts the renamed topic in its list (even if the dialog is gone). */
  onSaved?: (session: TopicRenameSession, topic: any) => void;
  messages: () => { empty: string; saveFailed: string; suggestFailed: string };
}

function failure(error: unknown, fallback: string) {
  return String((error as Error)?.message || "").trim() || fallback;
}

/** Collapses white space the way the runtime does, so what is checked is what is saved. */
export function normalizeTopicTitleDraft(value: string) {
  return String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function createTopicRename(deps: TopicRenameDeps) {
  const session = signal<TopicRenameSession | null>(null);
  const draft = signal("");
  const error = signal("");
  const suggesting = signal(false);
  const saving = signal(false);
  let seq = 0;
  // Moves on with every change to the draft, so a suggestion knows whether it would replace an edit.
  let edits = 0;

  const open = () => session() !== null;
  const saveDisabled = () => !open() || saving() || suggesting() || normalizeTopicTitleDraft(draft()) === "";

  function start(target: TopicRenameTarget) {
    const title = String(target.title ?? "").trim();
    batch(() => {
      seq += 1;
      edits += 1;
      session.set({ seq, endpointRef: target.endpointRef, topicID: target.topicID, title });
      draft.set(title);
      error.set("");
      suggesting.set(false);
      saving.set(false);
    });
  }

  /** Closes the dialog; a save under way keeps it open unless `force` (the topic or runtime went). */
  function close(options: { force?: boolean } = {}) {
    if (!untracked(session)) return;
    if (untracked(saving) && !options.force) return;
    batch(() => {
      session.set(null);
      error.set("");
      suggesting.set(false);
      saving.set(false);
    });
  }

  function setDraft(value: string) {
    const next = String(value ?? "");
    if (next === untracked(draft)) return;
    edits += 1;
    batch(() => {
      draft.set(next);
      error.set("");
    });
  }

  async function regenerate() {
    const current = untracked(session);
    if (!current || untracked(suggesting) || untracked(saving)) return;
    const asked = edits;
    batch(() => {
      suggesting.set(true);
      error.set("");
    });
    try {
      const suggestion = await deps.suggest(current.endpointRef, current.topicID);
      if (untracked(session) !== current) return;
      const title = Array.from(normalizeTopicTitleDraft(String(suggestion?.title || "")))
        .slice(0, TOPIC_TITLE_MAX_LENGTH)
        .join("");
      if (!title) throw new Error(deps.messages().suggestFailed);
      // The person typed while it was generated: their edit stays.
      if (edits !== asked) return;
      edits += 1;
      draft.set(title);
    } catch (err) {
      if (untracked(session) === current) error.set(failure(err, deps.messages().suggestFailed));
    } finally {
      if (untracked(session) === current) suggesting.set(false);
    }
  }

  async function save() {
    const current = untracked(session);
    if (!current || untracked(saving) || untracked(suggesting)) return;
    const title = normalizeTopicTitleDraft(untracked(draft));
    if (!title) {
      error.set(deps.messages().empty);
      return;
    }
    batch(() => {
      saving.set(true);
      error.set("");
    });
    try {
      const topic = await deps.save(current.endpointRef, current.topicID, title);
      deps.onSaved?.(current, topic);
      if (untracked(session) !== current) return;
      batch(() => {
        session.set(null);
        saving.set(false);
      });
    } catch (err) {
      if (untracked(session) !== current) return;
      batch(() => {
        saving.set(false);
        error.set(failure(err, deps.messages().saveFailed));
      });
    }
  }

  return {
    session,
    open,
    draft,
    error,
    suggesting,
    saving,
    saveDisabled,
    start,
    close,
    setDraft,
    regenerate,
    save,
  };
}

export type TopicRename = ReturnType<typeof createTopicRename>;
