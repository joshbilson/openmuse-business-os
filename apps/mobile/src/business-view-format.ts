import type { BusinessViewRow } from "../../../packages/domain/src/business-view";

/** Source amounts remain strings; the client never derives a balance or rounds them. */
export function formatBusinessMoney(money: BusinessViewRow["money"]) {
  if (!money) return undefined;
  if (money.decimal !== undefined) return `${money.currency} ${money.decimal}`;
  if (money.minorUnits !== undefined) {
    const currency = money.currency.toUpperCase();
    const fractionDigits =
      currency === "JPY"
        ? 0
        : ["AUD", "CAD", "USD", "EUR", "GBP"].includes(currency)
          ? 2
          : undefined;
    const source = money.minorUnits;
    if (fractionDigits === undefined || !/^[+-]?\d+$/.test(source))
      return `${source} minor units (${money.currency})`;
    const sign = source[0] === "-" || source[0] === "+" ? source[0] : "";
    const digits = source.slice(sign ? 1 : 0).replace(/^0+(?=\d)/, "");
    if (fractionDigits === 0) return `${currency} ${sign}${digits}`;
    const padded = digits.padStart(fractionDigits + 1, "0");
    return `${currency} ${sign}${padded.slice(0, -fractionDigits)}.${padded.slice(-fractionDigits)}`;
  }
  return undefined;
}
