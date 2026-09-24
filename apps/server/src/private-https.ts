import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

// Explicitly list TLS 1.3 and 1.2 suites. OpenSSL's legacy cipher selectors
// do not constrain TLS 1.3, so both protocol generations need named suites.
export const aes256Ciphers = [
  "TLS_AES_256_GCM_SHA384",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
].join(":");

export function privateHttpsOptions(env: NodeJS.ProcessEnv, publicUrl: string, apiPort: number) {
  const certFile = env.PRIVATE_HTTPS_CERT_FILE;
  const keyFile = env.PRIVATE_HTTPS_KEY_FILE;
  const portText = env.PRIVATE_HTTPS_PORT;
  if (!certFile && !keyFile && !portText) return undefined;
  if (!certFile || !keyFile)
    throw new Error("PRIVATE_HTTPS_CERT_FILE and PRIVATE_HTTPS_KEY_FILE must both be set");
  const port = Number(portText ?? "8792");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === apiPort)
    throw new Error("PRIVATE_HTTPS_PORT must be a valid port distinct from the HTTP API port");
  const url = new URL(publicUrl);
  if (url.protocol !== "https:") throw new Error("Private HTTPS requires an HTTPS PUBLIC_API_URL");
  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);
  const leaf = new X509Certificate(cert);
  const certificateKey = leaf.publicKey.export({ type: "spki", format: "der" });
  const suppliedKey = createPublicKey(createPrivateKey(key)).export({
    type: "spki",
    format: "der",
  });
  if (!certificateKey.equals(suppliedKey))
    throw new Error("Private HTTPS certificate and key do not match");
  if (!leaf.checkHost(url.hostname))
    throw new Error("Private HTTPS certificate does not cover PUBLIC_API_URL hostname");
  const now = Date.now();
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  if (
    !Number.isFinite(notBefore) ||
    !Number.isFinite(notAfter) ||
    now < notBefore ||
    now >= notAfter
  )
    throw new Error("Private HTTPS certificate is outside its validity period");
  return {
    createServer,
    port,
    hostname: "127.0.0.1",
    serverOptions: {
      cert,
      key,
      minVersion: "TLSv1.2" as const,
      maxVersion: "TLSv1.3" as const,
      ciphers: aes256Ciphers,
      honorCipherOrder: true,
    },
  };
}
