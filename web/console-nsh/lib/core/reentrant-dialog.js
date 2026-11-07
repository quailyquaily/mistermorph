// Opens a dialog again even when it is open: closes it first, so it plays its opening again.
// `open` is a signal of the dialog's open state.
export async function openReentrantDialog(open) {
  if (!open || typeof open.set !== "function") {
    return;
  }
  if (open()) {
    open.set(false);
    await Promise.resolve();
  }
  open.set(true);
}
