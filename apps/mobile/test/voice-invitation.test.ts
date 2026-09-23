import assert from "node:assert/strict";
import test from "node:test";
import { canAnswerInvitation } from "../src/voice-invitation";

test("only a live ringing invitation may start microphone setup", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  assert.equal(
    canAnswerInvitation({ status: "ringing", expiresAt: "2026-09-23T12:00:45Z" }, now),
    true,
  );
  assert.equal(
    canAnswerInvitation({ status: "ringing", expiresAt: "2026-09-23T12:00:00Z" }, now),
    false,
  );
  assert.equal(
    canAnswerInvitation({ status: "declined", expiresAt: "2026-09-23T12:00:45Z" }, now),
    false,
  );
  assert.equal(canAnswerInvitation({ status: "ringing", expiresAt: "invalid" }, now), false);
});
