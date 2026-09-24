import assert from "node:assert/strict";
import test from "node:test";
import { restoreSavedMessages } from "../src/thread-hydration";

test("fresh connection reset cannot erase Oracle's saved conversation", async () => {
  const saved = [
    { id: "user-1", role: "user", content: "Show me the latest payment" },
    { id: "assistant-1", role: "assistant", content: "Correction: the latest payment is…" },
  ];
  let visible: typeof saved = [];
  const order: string[] = [];
  await restoreSavedMessages(
    async () => {
      visible = [];
      order.push("connect reset");
    },
    async () => {
      order.push("load saved");
      return saved;
    },
    (messages) => {
      visible = messages;
      order.push("show saved");
    },
    () => true,
  );
  assert.deepEqual(order, ["connect reset", "load saved", "show saved"]);
  assert.deepEqual(visible, saved);
});

test("an old thread does not replace the newly selected conversation", async () => {
  let current = true;
  let read = false;
  let applied = false;
  await restoreSavedMessages(
    async () => {
      current = false;
    },
    async () => {
      read = true;
      return ["old message"];
    },
    () => {
      applied = true;
    },
    () => current,
  );
  assert.equal(read, false);
  assert.equal(applied, false);
});
