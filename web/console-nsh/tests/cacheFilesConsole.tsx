// A test entry (tests/harness.ts `openConsole({ cacheFiles: true })`): the phone app with a store
// on disk for its cache (lib/cacheFiles.ts). A headless app has no files of its own, so the store's
// files are kept in the app's storage under `cachefs:`: a test gives one app's storage to the next
// (`kv`), which then starts as an app that was closed and opened again.
import { Storage } from "nsh";
import { useCacheFsForTests } from "../lib/cache";
// App.tsx starts the app as it loads, but its start awaits the host's boot data first: the file
// system below is set before the cache starts.
import "../App";

const PREFIX = "cachefs:";
const missing = (path: string) => Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });

useCacheFsForTests({
  async readFile(path) {
    const text = await Storage.getItem(PREFIX + path);
    if (text === null) throw missing(path);
    return text;
  },
  writeFile: (path, data) => Storage.setItem(PREFIX + path, data),
  async readdir(dir) {
    const start = `${PREFIX}${dir}/`;
    return (await Storage.keys()).filter((key) => key.startsWith(start)).map((key) => key.slice(start.length));
  },
  async unlink(path) {
    if ((await Storage.getItem(PREFIX + path)) === null) throw missing(path);
    await Storage.removeItem(PREFIX + path);
  },
  async mkdir() {},
  async rename(from, to) {
    const text = await Storage.getItem(PREFIX + from);
    if (text === null) throw missing(from);
    await Storage.setItem(PREFIX + to, text);
    await Storage.removeItem(PREFIX + from);
  },
});
