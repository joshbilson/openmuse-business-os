import assert from "node:assert/strict";
import test from "node:test";
import { endVoiceCallInParallel } from "../src/voice-cleanup";

test("Oracle call ends even when the CallKit end transaction never resolves", async () => {
  const events: string[] = [];
  const pendingNativeEnd = new Promise<void>(() => {});
  await endVoiceCallInParallel(
    () => {
      events.push("native end requested");
      return pendingNativeEnd;
    },
    async () => {
      events.push("Oracle end requested");
    },
  );
  assert.deepEqual(events, ["native end requested", "Oracle end requested"]);
});

test("a synchronous native bridge failure does not suppress Oracle cleanup", async () => {
  let serverEnded = false;
  await endVoiceCallInParallel(
    () => {
      throw new Error("native bridge unavailable");
    },
    async () => {
      serverEnded = true;
    },
  );
  assert.equal(serverEnded, true);
});
