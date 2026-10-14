import assert from "node:assert/strict";
import test from "node:test";

import { SessionTurnCoordinator } from "../src/bridge/session-turn.js";

test("serializes tasks for one session while allowing different sessions to run", async () => {
  const coordinator = new SessionTurnCoordinator();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.run("session-a", async () => {
    events.push("a:start");
    await firstBlocked;
    events.push("a:end");
    return "first";
  });
  const second = coordinator.run("session-a", async () => {
    events.push("a2:start");
    events.push("a2:end");
    return "second";
  });
  const other = coordinator.run("session-b", async () => {
    events.push("b:start");
    events.push("b:end");
    return "other";
  });

  await other;
  assert.deepEqual(events, ["a:start", "b:start", "b:end"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["a:start", "b:start", "b:end", "a:end", "a2:start", "a2:end"]);
});
