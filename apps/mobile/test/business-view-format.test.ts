import assert from "node:assert/strict";
import test from "node:test";
import { formatBusinessMoney } from "../src/business-view-format";

test("business snapshot money preserves exact source precision and units", () => {
  assert.equal(formatBusinessMoney({ currency: "AUD", decimal: "1234.567890" }), "AUD 1234.567890");
  for (const currency of ["AUD", "CAD", "USD", "EUR", "GBP"]) {
    assert.equal(formatBusinessMoney({ currency, minorUnits: "1234" }), `${currency} 12.34`);
  }
  assert.equal(formatBusinessMoney({ currency: "AUD", minorUnits: "-1" }), "AUD -0.01");
  assert.equal(formatBusinessMoney({ currency: "GBP", minorUnits: "0005" }), "GBP 0.05");
  assert.equal(
    formatBusinessMoney({ currency: "JPY", minorUnits: "12345678901234567890" }),
    "JPY 12345678901234567890",
  );
  assert.equal(
    formatBusinessMoney({ currency: "USD", minorUnits: "-123456789012345678901234567890" }),
    "USD -1234567890123456789012345678.90",
  );
  assert.equal(
    formatBusinessMoney({ currency: "BTC", minorUnits: "1234" }),
    "1234 minor units (BTC)",
  );
  assert.equal(
    formatBusinessMoney({ currency: "AUD", minorUnits: "1.2" }),
    "1.2 minor units (AUD)",
  );
  assert.equal(formatBusinessMoney(undefined), undefined);
});
