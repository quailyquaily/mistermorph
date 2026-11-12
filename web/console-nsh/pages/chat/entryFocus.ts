// The focus a view asks for as it opens, for a field that may not be in place yet (a pane still
// sliding in): one request at a time, made once the field has arrived and only if the view still
// wants it then. A newer request or `cancel` drops the one waiting, so it never lands after the
// user went on (another view, the keyboard lowered, a sheet opened). Nothing retries: a request
// that was dropped or not wanted any more is gone.

export interface EntryFocus {
  /**
   * Focuses at once when `arrived` is null; else once it resolves, if this is still the latest
   * request and `wanted()` says so then. A rejected `arrived` focuses nothing.
   */
  request(arrived: Promise<unknown> | null | undefined, wanted: () => boolean): void;
  /** Drops the request waiting, if any. */
  cancel(): void;
}

export function createEntryFocus(focus: () => void): EntryFocus {
  let latest = 0;
  return {
    request(arrived, wanted) {
      const id = ++latest;
      if (!arrived) {
        focus();
        return;
      }
      arrived.then(
        () => {
          if (id === latest && wanted()) focus();
        },
        () => undefined,
      );
    },
    cancel() {
      latest += 1;
    },
  };
}
