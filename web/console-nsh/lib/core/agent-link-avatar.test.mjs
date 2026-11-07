import assert from "node:assert/strict";
import test from "node:test";

import { agentLinkAvatarURL, agentLinkInstanceID } from "./agent-link-avatar.js";

const ID = "inst_0123456789abcdef0123456789abcdef";
const endpoints = [
  { endpoint_ref: "console-local", instance_id: "inst_ffffffffffffffffffffffffffffffff", avatar_url: "data:image/png;base64,bG9jYWw=" },
  { endpoint_ref: "ep_b", instance_id: ID, avatar_url: "data:image/webp;base64,Yg==" },
  { endpoint_ref: "ep_c", instance_id: "inst_cccccccccccccccccccccccccccccccc", avatar_url: "" },
];

test("agentLinkInstanceID reads the instance ID of an Agent Link contact", () => {
  assert.equal(agentLinkInstanceID(`mm:${ID}`), ID);
  assert.equal(agentLinkInstanceID(` MM:${ID} `), ID);
  assert.equal(agentLinkInstanceID("tg:12345"), "");
  assert.equal(agentLinkInstanceID("mm:not-an-instance"), "");
  assert.equal(agentLinkInstanceID(undefined), "");
});

test("agentLinkAvatarURL takes the avatar of the endpoint with the contact's instance ID", () => {
  assert.equal(agentLinkAvatarURL({ contact_id: `mm:${ID}` }, endpoints), "data:image/webp;base64,Yg==");
});

test("agentLinkAvatarURL is empty when there is no avatar to show", () => {
  // An agent that is not one of this Console's endpoints.
  assert.equal(agentLinkAvatarURL({ contact_id: "mm:inst_dddddddddddddddddddddddddddddddd" }, endpoints), "");
  // An endpoint without an avatar.
  assert.equal(agentLinkAvatarURL({ contact_id: "mm:inst_cccccccccccccccccccccccccccccccc" }, endpoints), "");
  // Not an Agent Link contact, and no endpoint list.
  assert.equal(agentLinkAvatarURL({ contact_id: "tg:12345" }, endpoints), "");
  assert.equal(agentLinkAvatarURL({ contact_id: `mm:${ID}` }, undefined), "");
});
