import assert from "node:assert/strict";
import test from "node:test";

import { llmSecretConfigPath, secretStorageKind } from "./secret-storage.js";

test("both settings APIs' sources map to the same storage kinds", () => {
  assert.equal(secretStorageKind("os"), "os");
  assert.equal(secretStorageKind("config_os_ref"), "os");
  assert.equal(secretStorageKind("file"), "file");
  assert.equal(secretStorageKind("env"), "env");
  assert.equal(secretStorageKind("config_env_ref"), "env");
  assert.equal(secretStorageKind("environment_override"), "env");
  assert.equal(secretStorageKind("aws-sm"), "aws");
  assert.equal(secretStorageKind("config_aws_ref"), "aws");
  assert.equal(secretStorageKind(""), "stored");
  assert.equal(secretStorageKind(undefined), "stored");
});

test("an LLM form field maps to its config path", () => {
  assert.equal(llmSecretConfigPath("llm", "api_key"), "llm.api_key");
  assert.equal(llmSecretConfigPath("llm.profiles.backup", "bedrock_aws_key"), "llm.profiles.backup.bedrock.aws_key");
  assert.equal(llmSecretConfigPath("llm", "cloudflare_api_token"), "llm.cloudflare.api_token");
  assert.equal(llmSecretConfigPath("", "api_key"), "");
  assert.equal(llmSecretConfigPath("llm", "model"), "");
});
