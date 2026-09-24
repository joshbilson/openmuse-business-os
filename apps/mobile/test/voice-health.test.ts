import assert from "node:assert/strict";
import test from "node:test";
import { VoiceCallHealth } from "../src/voice-health";

function clock() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    pending,
    schedule(callback: () => void, _delay: number) {
      const id = ++next;
      pending.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel(id: ReturnType<typeof setTimeout>) {
      pending.delete(id as unknown as number);
    },
    expire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("a brief media or Oracle outage recovers without ending the same call", () => {
  const time = clock();
  const events: string[] = [];
  const health = new VoiceCallHealth(
    {
      onReconnecting: () => events.push("reconnecting"),
      onRecovered: () => events.push("recovered"),
      onEnded: (reason) => events.push(reason),
    },
    15000,
    time.schedule,
    time.cancel,
  );
  health.media({ state: "connected" });
  health.start();
  health.media({ state: "disconnected" });
  health.server(false);
  health.media({ state: "connected" });
  assert.deepEqual(events, ["reconnecting"]);
  health.server(true);
  time.expire();
  assert.deepEqual(events, ["reconnecting", "recovered"]);
});

test("prolonged loss and provider session close terminate once", () => {
  const time = clock();
  const events: string[] = [];
  const health = new VoiceCallHealth(
    {
      onReconnecting: () => events.push("reconnecting"),
      onRecovered: () => events.push("recovered"),
      onEnded: (reason) => events.push(reason),
    },
    15000,
    time.schedule,
    time.cancel,
  );
  health.media({ state: "connected" });
  health.start();
  health.server(false);
  assert.equal(time.pending.size, 1);
  time.expire();
  health.media({ state: "ended", reason: "The voice session ended." });
  assert.deepEqual(events, [
    "reconnecting",
    "Voice connection was lost. Start a new call to continue.",
  ]);

  const closed: string[] = [];
  const provider = new VoiceCallHealth({
    onReconnecting: () => closed.push("reconnecting"),
    onRecovered: () => closed.push("recovered"),
    onEnded: (reason) => closed.push(reason),
  });
  provider.media({ state: "ended", reason: "The voice session ended." });
  provider.start();
  assert.deepEqual(closed, ["The voice session ended."]);
});

test("default browser timers are not invoked with the monitor as their receiver", () => {
  const originalSet = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const originalClear = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  assert.ok(originalSet);
  assert.ok(originalClear);
  let scheduledBy: unknown;
  let cancelledBy: unknown;
  let scheduled = false;
  let cancelled = false;
  const events: string[] = [];
  let health: VoiceCallHealth;
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: function (this: unknown) {
      scheduled = true;
      scheduledBy = this;
      return 1;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: function (this: unknown) {
      cancelled = true;
      cancelledBy = this;
    },
  });
  try {
    health = new VoiceCallHealth({
      onReconnecting: () => events.push("reconnecting"),
      onRecovered: () => events.push("recovered"),
      onEnded: () => events.push("ended"),
    });
    health.media({ state: "connected" });
    health.start();
    health.media({ state: "disconnected" });
    health.media({ state: "connected" });
    assert.equal(scheduled, true);
    assert.equal(cancelled, true);
    assert.notEqual(scheduledBy, health);
    assert.notEqual(cancelledBy, health);
    assert.deepEqual(events, ["reconnecting", "recovered"]);
  } finally {
    Object.defineProperty(globalThis, "setTimeout", originalSet);
    Object.defineProperty(globalThis, "clearTimeout", originalClear);
  }
});
