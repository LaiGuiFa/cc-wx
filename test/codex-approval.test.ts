import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalBroker } from "../src/codex/approval.js";

test("approval requests are fail-closed and scoped to their sender", async () => {
  const broker = new ApprovalBroker(undefined, 50);
  const outcome = broker.request({
    kind: "command",
    senderId: "alice",
    accountId: "account-a",
    command: "echo safe"
  });
  const [request] = broker.list();
  assert.equal(request.senderId, "alice");
  assert.equal(broker.resolve(request.id, "accept", (candidate) => candidate.senderId === "bob"), false);
  assert.equal(broker.resolve(request.id, "accept", (candidate) => candidate.senderId === "alice"), true);
  assert.equal(await outcome, "accept");
});

test("pending approvals are cancelled when they time out", async () => {
  const broker = new ApprovalBroker(undefined, 5);
  const outcome = broker.request({ kind: "file-change", senderId: "alice" });
  assert.equal(await outcome, "cancel");
  assert.deepEqual(broker.list(), []);
});
