// The topic list's older pages, one press at a time (the topic list's "Load older topics", FT173):
// a press asks for the page after the cursor and nothing more until that page has come or failed,
// so a second press, a key repeat or a press during the first page's refresh sends no request. A
// page that fails leaves the cursor and the topics as they were and says so in the control (`error`),
// and the next press tries the same page again. `reset` forgets a page still on its way (another
// agent, the topic list turned off): it lands nowhere, and its failure says nothing.
import { batch, signal, untracked } from "nsh";

export interface OlderTopicPage {
  items: any[];
  nextCursor: string;
}

export interface OlderTopicPagesOptions {
  /** The cursor of the next older page ("" when there is none). Read untracked. */
  cursor: () => string;
  /** No press may start a load now (the first page is loading, the topic list is off). Read untracked. */
  blocked: () => boolean;
  /** Asks for the page after `cursor`. */
  fetch: (cursor: string) => Promise<OlderTopicPage>;
  /** Puts a page that came into the list (and takes its cursor). */
  land: (page: OlderTopicPage) => void;
  /** What a failure says when the error has no message of its own. */
  errorText: (error: unknown) => string;
}

export function createOlderTopicPages(options: OlderTopicPagesOptions) {
  /** A page is on its way: from the press until it came or failed. */
  const loading = signal(false);
  /** Why the last page did not come ("" when it did, or none was asked for since). */
  const error = signal("");
  let version = 0;

  /** Loads the next older page; true once it landed, false when nothing was asked or it failed. */
  async function load(): Promise<boolean> {
    const cursor = String(options.cursor() || "").trim();
    if (!cursor || untracked(loading) || options.blocked()) return false;
    const mine = ++version;
    batch(() => {
      loading.set(true);
      error.set("");
    });
    try {
      const page = await options.fetch(cursor);
      if (mine !== version) return false;
      batch(() => {
        options.land(page);
        loading.set(false);
      });
      return true;
    } catch (failure) {
      if (mine !== version) return false;
      batch(() => {
        error.set(options.errorText(failure));
        loading.set(false);
      });
      return false;
    }
  }

  /** Forgets the page on its way and the last failure: the list starts over. */
  function reset() {
    version++;
    batch(() => {
      loading.set(false);
      error.set("");
    });
  }

  /** The last failure goes (the first page came again: a new cursor, nothing to retry). */
  function clearError() {
    error.set("");
  }

  return { loading, error, load, reset, clearError };
}
