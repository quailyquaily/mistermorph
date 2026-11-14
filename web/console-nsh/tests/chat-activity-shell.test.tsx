// A failed shell call in Progress (ChatStatusCard's ShellResult): its command whole, its exit code
// and what it printed to stderr and stdout together, not the generic "bash exited with code N";
// an empty stream or no output at all said so; what the server did not keep, and what the tool's
// output limit cut, labelled. A successful call and other tools' errors look as before.
import { expect, test, type App } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

const FATAL = "fatal: unable to access 'https://example.invalid/repo.git/': Could not resolve host: example.invalid";
const LONG_COMMAND = [
  "set -e",
  "cd /srv/checkouts/mistermorph",
  ...Array.from({ length: 6 }, (_, i) => `git config --local remote.mirror${i}.url https://example.invalid/mirror-${i}/repo.git`),
  "git fetch --prune --tags mirror5",
].join("\n");
const CHILD_COMMAND = `git -C /srv/checkouts/mistermorph push --force-with-lease origin HEAD:refs/heads/${"feature-".repeat(16)}end`;

const TASK = {
  id: "t1",
  task: "Sync the mirrors",
  topic_id: "topic-1",
  created_at: NOW,
  started_at: NOW,
  status: "failed",
  result: {
    activity: {
      history: [
        { id: "ok", kind: "tool", name: "bash", status: "done", args: { cmd: "git status --short" }, at: NOW },
        {
          id: "git",
          kind: "tool",
          name: "bash",
          status: "failed",
          args: { cmd: LONG_COMMAND },
          error: "bash exited with code 128",
          shell: { exit_code: 128, stdout: "", stderr: `${FATAL}\n` },
          at: NOW,
        },
        {
          id: "tests",
          kind: "tool",
          name: "bash",
          status: "failed",
          args: { cmd: "go test ./..." },
          error: "bash exited with code 1",
          shell: { exit_code: 1, stdout: "--- FAIL: TestSync (0.00s)\nFAIL\n", stderr: "", stdout_omitted: 4321, stdout_truncated: true },
        },
        {
          id: "silent",
          kind: "tool",
          name: "bash",
          status: "failed",
          args: { cmd: "test -d /srv/missing" },
          error: "bash exited with code 1",
          shell: { exit_code: 1, stdout: "", stderr: "" },
        },
        {
          id: "slow",
          kind: "tool",
          name: "bash",
          status: "failed",
          args: { cmd: "make e2e" },
          error: "bash timed out after 30s",
          shell: { exit_code: 124, stdout: "starting\n", stderr: "", reason: "bash timed out after 30s" },
        },
        { id: "read", kind: "tool", name: "read_file", status: "failed", args: { path: "/srv/none" }, error: "open /srv/none: no such file or directory" },
        {
          id: "script",
          kind: "tool",
          name: "codemode",
          status: "failed",
          children: [
            {
              id: "script.0",
              kind: "tool",
              name: "bash",
              status: "failed",
              args: { cmd: CHILD_COMMAND },
              error: "bash exited with code 128",
              shell: { exit_code: 128, stdout: "", stderr: "error: failed to push some refs\n" },
            },
          ],
        },
      ],
    },
  },
};

const API = {
  "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } },
  "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [TASK] : [] } }),
  "GET /proxy:/tasks/t1": { body: TASK },
  "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
};

async function openProgress() {
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: API });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity >> id:chat-activity-shell");
  return app;
}

/** Whether the nth shell result shows `selector` (a `text:` one, or ids). */
function inShell(app: App, nth: number, selector: string) {
  return app.shows(`id:chat-activity-shell >> nth=${nth} >> ${selector}`);
}

test("a failed git command shows its whole command, exit code 128 and the fatal line from stderr", async () => {
  const app = await openProgress();
  // The long command shows whole, every line of it.
  expect(app.shows(`id:chat-activity-param >> text:${LONG_COMMAND}`)).toBe(true);
  expect(inShell(app, 0, "id:chat-activity-exit >> text:128")).toBe(true);
  expect(inShell(app, 0, "id:chat-activity-exit >> text:EXIT CODE")).toBe(true);
  expect(inShell(app, 0, `id:chat-activity-stderr >> text:${FATAL}`)).toBe(true);
  // Its stdout was empty, and says so; the generic exit message is not what shows.
  expect(app.count("id:chat-activity-shell >> nth=0 >> id:chat-activity-stdout >> id:chat-activity-stream-empty")).toBe(1);
  expect(app.shows("text:bash exited with code 128")).toBe(false);
});

test("a stdout-only failure shows its stdout, with what was not kept and the tool's cut labelled", async () => {
  const app = await openProgress();
  expect(inShell(app, 1, "id:chat-activity-stdout >> text:--- FAIL: TestSync (0.00s)\nFAIL")).toBe(true);
  expect(app.count("id:chat-activity-shell >> nth=1 >> id:chat-activity-stderr >> id:chat-activity-stream-empty")).toBe(1);
  expect(inShell(app, 1, "id:chat-activity-stdout >> text:┆ 4321 earlier characters not kept")).toBe(true);
  expect(inShell(app, 1, "id:chat-activity-stdout >> text:┆ Output past the tool's output limit was not captured.")).toBe(true);
  expect(app.shows("text:bash exited with code 1")).toBe(false);
});

test("a failure with no output says so, and a timeout gives its reason", async () => {
  const app = await openProgress();
  expect(app.count("id:chat-activity-no-output")).toBe(1);
  expect(inShell(app, 2, "text:No output: stdout and stderr were both empty.")).toBe(true);
  // Not a stream section where nothing was printed at all.
  expect(app.count("id:chat-activity-shell >> nth=2 >> id:chat-activity-stderr")).toBe(0);
  expect(inShell(app, 3, "text:bash timed out after 30s")).toBe(true);
  expect(inShell(app, 3, "id:chat-activity-exit >> text:124")).toBe(true);
  expect(inShell(app, 3, "id:chat-activity-stdout >> text:starting")).toBe(true);
});

test("a nested shell call shows its result, and its command whole where the tree line cuts it", async () => {
  const app = await openProgress();
  expect(inShell(app, 4, "id:chat-activity-stderr >> text:error: failed to push some refs")).toBe(true);
  expect(inShell(app, 4, `id:chat-activity-param >> text:${CHILD_COMMAND}`)).toBe(true);
});

test("successful shell calls and other tools' errors look as before", async () => {
  const app = await openProgress();
  // Five failed shell calls have results; the successful one only its command.
  expect(app.count("id:chat-activity-shell")).toBe(5);
  expect(app.shows("id:chat-activity-param >> text:git status --short")).toBe(true);
  expect(app.shows("text:open /srv/none: no such file or directory")).toBe(true);
});
