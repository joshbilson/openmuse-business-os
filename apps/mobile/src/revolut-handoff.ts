/** Extract only the short-lived code from Revolut's exact registered callback. */
export function parseRevolutHandoff(
  pasted: string,
  callbackUrl: string,
  expectedState: string,
): string {
  const input = pasted.trim();
  if (!input || input.length > 8192) throw new Error("Paste the Revolut return address or code.");
  let code: string;
  if (/^https?:\/\//i.test(input)) {
    let returned: URL;
    try {
      returned = new URL(input);
    } catch {
      throw new Error("The Revolut return address is invalid.");
    }
    const callback = new URL(callbackUrl);
    if (
      returned.origin !== callback.origin ||
      returned.pathname !== callback.pathname ||
      returned.hash ||
      returned.username ||
      returned.password
    )
      throw new Error("Paste the registered Revolut return address, not another page.");
    if (returned.searchParams.has("error")) throw new Error("Revolut declined the connection.");
    const codes = returned.searchParams.getAll("code");
    const states = returned.searchParams.getAll("state");
    if (codes.length !== 1 || states.length > 1)
      throw new Error("The Revolut return address has invalid authorization details.");
    if (states.length === 1 && states[0] !== expectedState)
      throw new Error("This Revolut return address belongs to another connection attempt.");
    code = codes[0];
  } else {
    code = input;
  }
  if (code.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(code))
    throw new Error("The Revolut authorization code is invalid.");
  return code;
}
