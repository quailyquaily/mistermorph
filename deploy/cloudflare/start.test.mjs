import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morph-console-start-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "template.yaml"), "console:\n  endpoints: []\n");
  fs.writeFileSync(path.join(dir, "bin/mistermorph"), `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_ARGS"
printf 'saved by console\\n' > "$MISTER_MORPH_FILE_STATE_DIR/chat.txt"
if [ "\${TEST_HOLD:-0}" = 1 ]; then
  trap 'printf "saved during shutdown\\n" > "$MISTER_MORPH_FILE_STATE_DIR/shutdown.txt"; exit 0' TERM
  printf ready > "$TEST_READY"
  while true; do sleep 1 & wait $! || true; done
fi
exit "\${TEST_APP_EXIT:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin/aws"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_AWS_LOG"
case "$*" in
  *list-objects-v2*)
    [ "\${TEST_RESTORE_FAIL:-0}" != 1 ] || exit 1
    if [ -f "$TEST_REMOTE" ]; then printf 'test/state.tar.gz\\n'; else printf 'None\\n'; fi;;
  *'s3 cp'*)
    while [ "$1" != cp ]; do shift; done
    shift
    case "$1" in
      s3://*) cp "$TEST_REMOTE" "$2";;
      *) [ "\${TEST_UPLOAD_FAIL:-0}" != 1 ] || exit 1; cp "$1" "$TEST_REMOTE";;
    esac;;
esac
`, { mode: 0o755 });
  const env = {
    PATH: `${dir}/bin:${process.env.PATH}`, HOME: dir,
    MISTER_MORPH_CONSOLE_PASSWORD: "test-password",
    MISTER_MORPH_FILE_STATE_DIR: path.join(dir, "state"),
    MISTER_MORPH_FILE_CACHE_DIR: path.join(dir, "cache"),
    MISTER_MORPH_CONFIG_TEMPLATE: path.join(dir, "template.yaml"),
    MISTER_MORPH_R2_ACCOUNT_ID: "test-account",
    MISTER_MORPH_R2_BUCKET: "test-bucket",
    MISTER_MORPH_R2_PREFIX: "test",
    MISTER_MORPH_R2_ACCESS_KEY_ID: "dummy-access",
    MISTER_MORPH_R2_SECRET_ACCESS_KEY: "dummy-secret",
    TEST_ARGS: path.join(dir, "args"), TEST_REMOTE: path.join(dir, "remote.tar.gz"),
    TEST_AWS_LOG: path.join(dir, "aws.log"),
    TEST_READY: path.join(dir, "ready"),
  };
  return { dir, env, run(extra = {}) {
    return spawnSync("sh", [new URL("./start.sh", import.meta.url).pathname], {
      env: { ...env, ...extra }, encoding: "utf8", timeout: 10000,
    });
  } };
}

test("entrypoint starts Console on the container port and saves state on exit", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(f.env.TEST_ARGS, "utf8"), /console\nserve\n--console-listen\n0.0.0.0:8787/);
  assert.ok(fs.existsSync(f.env.TEST_REMOTE));
  assert.match(fs.readFileSync(path.join(f.env.MISTER_MORPH_FILE_STATE_DIR, "config.yaml"), "utf8"), /endpoints: \[\]/);
});

test("restart restores state and preserves Console-edited config", t => {
  const f = fixture(t);
  fs.mkdirSync(f.env.MISTER_MORPH_FILE_STATE_DIR);
  fs.writeFileSync(path.join(f.env.MISTER_MORPH_FILE_STATE_DIR, "config.yaml"), "llm:\n  model: saved-model\n");
  assert.equal(f.run().status, 0);
  fs.rmSync(f.env.MISTER_MORPH_FILE_STATE_DIR, { recursive: true });
  const result = f.run({ MISTER_MORPH_CONFIG_YAML: "llm:\n  model: new-seed\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.env.MISTER_MORPH_FILE_STATE_DIR, "config.yaml"), "utf8"), "llm:\n  model: saved-model\n");
  assert.equal(fs.readFileSync(path.join(f.env.MISTER_MORPH_FILE_STATE_DIR, "chat.txt"), "utf8"), "saved by console\n");
});

test("restore failure neither starts Console nor overwrites the backup", t => {
  const f = fixture(t);
  const result = f.run({ TEST_RESTORE_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.TEST_ARGS), false);
  assert.doesNotMatch(fs.readFileSync(f.env.TEST_AWS_LOG, "utf8"), /s3 cp/);
});

test("entrypoint refuses missing password and incomplete persistence configuration", t => {
  for (const extra of [
    { MISTER_MORPH_CONSOLE_PASSWORD: "   " },
    { MISTER_MORPH_R2_SECRET_ACCESS_KEY: "" },
    { MISTER_MORPH_R2_BACKUP_INTERVAL: "00" },
  ]) {
    const f = fixture(t);
    assert.notEqual(f.run(extra).status, 0);
    assert.equal(fs.existsSync(f.env.TEST_ARGS), false);
  }
});

test("final backup failure is visible in the process exit status", t => {
  const f = fixture(t);
  const result = f.run({ TEST_UPLOAD_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup.*failed/);
});

test("an application failure retains its exit status after backup", t => {
  const f = fixture(t);
  assert.equal(f.run({ TEST_APP_EXIT: "7" }).status, 7);
});

test("SIGTERM reaches Console and the final backup contains shutdown writes", async t => {
  const f = fixture(t);
  const child = spawn("sh", [new URL("./start.sh", import.meta.url).pathname], {
    env: { ...f.env, TEST_HOLD: "1" }, stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = once(child, "exit");
  for (let i = 0; i < 200 && !fs.existsSync(f.env.TEST_READY); i++) await delay(10);
  assert.ok(fs.existsSync(f.env.TEST_READY), "Console did not start");
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
  const archive = spawnSync("tar", ["-xOf", f.env.TEST_REMOTE, "./shutdown.txt"], { encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  assert.equal(archive.stdout, "saved during shutdown\n");
});

test("a corrupt backup prevents startup", t => {
  const f = fixture(t);
  fs.writeFileSync(f.env.TEST_REMOTE, "not an archive");
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(f.env.TEST_ARGS), false);
  assert.equal(fs.readFileSync(f.env.TEST_REMOTE, "utf8"), "not an archive");
});

test("periodic backup runs while Console is still alive", async t => {
  const f = fixture(t);
  const child = spawn("sh", [new URL("./start.sh", import.meta.url).pathname], {
    env: { ...f.env, TEST_HOLD: "1", MISTER_MORPH_R2_BACKUP_INTERVAL: "1" }, stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = once(child, "exit");
  for (let i = 0; i < 300 && !fs.existsSync(f.env.TEST_REMOTE); i++) await delay(10);
  const savedWhileRunning = fs.existsSync(f.env.TEST_REMOTE) && child.exitCode === null;
  child.kill("SIGTERM");
  await exited;
  assert.ok(savedWhileRunning, "state was not backed up while Console was running");
});
