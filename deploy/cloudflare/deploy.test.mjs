import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morph-cloudflare-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(new URL("./deploy.sh", import.meta.url), path.join(dir, "deploy.sh"));
  fs.mkdirSync(path.join(dir, "bin"));
  for (const name of ["npm", "docker", "npx"]) {
    fs.writeFileSync(path.join(dir, "bin", name), `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> "$TEST_LOG"\nif [ '${name}' = npx ]; then\n case " $* " in *' secret bulk '*) cat > "$TEST_SECRETS";; *' secret put '*) cat >/dev/null;; esac\nfi\n`, { mode: 0o755 });
  }
  const env = {
    PATH: `${dir}/bin:${process.env.PATH}`, HOME: dir,
    TEST_LOG: path.join(dir, "calls"), TEST_SECRETS: path.join(dir, "secrets.json"),
    SKIP_NPM_INSTALL: "1",
    MISTER_MORPH_ALLOW_EPHEMERAL_STATE: "1",
  };
  return { dir, env, run(extra = {}, args = []) {
    return spawnSync("bash", [path.join(dir, "deploy.sh"), ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  } };
}

test("deploy loads env.sh and uploads custom config as a secret without image staging", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "env.sh"), [
    "export MISTER_MORPH_CONSOLE_PASSWORD='test-console'",
    "export MISTER_MORPH_SERVER_AUTH_TOKEN='test-admin'",
    "export WRANGLER_ENV=prod",
    "export MISTER_MORPH_CONFIG_PATH=custom.yaml",
  ].join("\n"));
  const config = 'llm:\n  model: "example"\n';
  fs.writeFileSync(path.join(f.dir, "custom.yaml"), config);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const secrets = JSON.parse(fs.readFileSync(f.env.TEST_SECRETS, "utf8"));
  assert.equal(secrets.MISTER_MORPH_CONSOLE_PASSWORD, "test-console");
  assert.equal(secrets.MISTER_MORPH_SERVER_AUTH_TOKEN, "test-admin");
  assert.equal(secrets.MISTER_MORPH_CONFIG_YAML, config);
  assert.equal(fs.existsSync(path.join(f.dir, "config.runtime.yaml")), false);
  const calls = fs.readFileSync(f.env.TEST_LOG, "utf8");
  assert.match(calls, /bulk\n--env\nprod/);
  assert.match(calls, /deploy\n--env\nprod/);
  assert.doesNotMatch(result.stdout + result.stderr + calls, /test-console|test-admin/);
});

test("deploy refuses missing authentication before any cloud operation", t => {
  for (const env of [{}, { MISTER_MORPH_CONSOLE_PASSWORD: "test-console" }]) {
    const f = fixture(t);
    const result = f.run(env);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(f.env.TEST_LOG), false);
  }
});

test("deploy does not require an LLM key for first-run Console setup", t => {
  const f = fixture(t);
  const result = f.run({
    MISTER_MORPH_CONSOLE_PASSWORD: "test-console", MISTER_MORPH_SERVER_AUTH_TOKEN: "test-admin",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("deploy requires complete R2 settings unless ephemeral state is explicit", t => {
  const f = fixture(t);
  const result = f.run({
    MISTER_MORPH_CONSOLE_PASSWORD: "test-console", MISTER_MORPH_SERVER_AUTH_TOKEN: "test-admin",
    MISTER_MORPH_ALLOW_EPHEMERAL_STATE: "0",
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.TEST_LOG), false);
});

test("deploy forwards R2 credentials as secrets without exposing them in arguments", t => {
  const f = fixture(t);
  const result = f.run({
    MISTER_MORPH_CONSOLE_PASSWORD: "test-console", MISTER_MORPH_SERVER_AUTH_TOKEN: "test-admin",
    MISTER_MORPH_ALLOW_EPHEMERAL_STATE: "0",
    MISTER_MORPH_R2_ACCOUNT_ID: "test-account", MISTER_MORPH_R2_BUCKET: "test-bucket",
    MISTER_MORPH_R2_PREFIX: "prod", MISTER_MORPH_R2_ACCESS_KEY_ID: "test-access",
    MISTER_MORPH_R2_SECRET_ACCESS_KEY: "test-r2-secret",
  });
  assert.equal(result.status, 0, result.stderr);
  const secrets = JSON.parse(fs.readFileSync(f.env.TEST_SECRETS, "utf8"));
  assert.equal(secrets.MISTER_MORPH_R2_SECRET_ACCESS_KEY, "test-r2-secret");
  assert.equal(secrets.MISTER_MORPH_ALLOW_EPHEMERAL_STATE, "0");
  assert.doesNotMatch(fs.readFileSync(f.env.TEST_LOG, "utf8"), /test-r2-secret/);
});

test("an oversized seed fails before uploading any secrets", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "large.yaml"), "#" + "界".repeat(2000));
  const result = f.run({
    MISTER_MORPH_CONSOLE_PASSWORD: "test-console", MISTER_MORPH_SERVER_AUTH_TOKEN: "test-admin",
    MISTER_MORPH_CONFIG_PATH: "large.yaml",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /5120/);
  assert.equal(fs.existsSync(f.env.TEST_LOG), false);
});

test("CLI environment overrides and dry-run cannot silently upload secrets", t => {
  for (const args of [["--env", "staging"], ["--dry-run"]]) {
    const f = fixture(t);
    const result = f.run({
      MISTER_MORPH_CONSOLE_PASSWORD: "test-console", MISTER_MORPH_SERVER_AUTH_TOKEN: "test-admin",
    }, args);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(f.env.TEST_LOG), false);
  }
});
