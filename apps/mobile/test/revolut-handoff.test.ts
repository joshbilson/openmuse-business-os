import assert from "node:assert/strict";
import test from "node:test";
import { parseRevolutHandoff } from "../src/revolut-handoff";

const callback = "https://oracle.example.test:10001/api/business/oauth/revolut/callback";
const state = "current-owner-session-state";

test("Revolut handoff extracts only the code from the registered callback", () => {
  assert.equal(
    parseRevolutHandoff(`${callback}?code=oa_prod_example`, callback, state),
    "oa_prod_example",
  );
  assert.equal(
    parseRevolutHandoff(`${callback}?state=${state}&code=oa_prod_example`, callback, state),
    "oa_prod_example",
  );
  assert.equal(parseRevolutHandoff(" oa_prod_example ", callback, state), "oa_prod_example");
});

test("Revolut handoff rejects a different callback, state, or ambiguous code", () => {
  for (const value of [
    "https://other.example.test/api/business/oauth/revolut/callback?code=oa_prod_example",
    `${callback}?code=oa_prod_example&state=another-state`,
    `${callback}?code=first&code=second`,
    `${callback}?error=access_denied&code=oa_prod_example`,
    `${callback}?code=oa_prod_example#fragment`,
  ])
    assert.throws(() => parseRevolutHandoff(value, callback, state));
});
