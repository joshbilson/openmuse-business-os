import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect, type TLSSocket } from "node:tls";
import { serve } from "@hono/node-server";
import { privateHttpsOptions } from "../apps/server/src/private-https.ts";

test("private HTTPS accepts only AES-256 TLS 1.2 and 1.3 while serving the app", {
  timeout: 15_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-https-"));
  const certFile = join(dir, "cert.pem"),
    keyFile = join(dir, "key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    const env = {
      PRIVATE_HTTPS_CERT_FILE: certFile,
      PRIVATE_HTTPS_KEY_FILE: keyFile,
      PRIVATE_HTTPS_PORT: "9443",
    };
    const wrongKey = join(dir, "wrong-key.pem");
    execFileSync(
      "openssl",
      ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", wrongKey],
      {
        stdio: "ignore",
      },
    );
    assert.equal(privateHttpsOptions({}, "https://localhost:10001", 8791), undefined);
    assert.throws(() =>
      privateHttpsOptions({ PRIVATE_HTTPS_CERT_FILE: certFile }, "https://localhost:10001", 8791),
    );
    assert.throws(() =>
      privateHttpsOptions({ ...env, PRIVATE_HTTPS_PORT: "8791" }, "https://localhost:10001", 8791),
    );
    assert.throws(() => privateHttpsOptions(env, "https://wrong.example:10001", 8791));
    assert.throws(() =>
      privateHttpsOptions(
        { ...env, PRIVATE_HTTPS_KEY_FILE: wrongKey },
        "https://localhost:10001",
        8791,
      ),
    );
    const options = privateHttpsOptions(env, "https://localhost:10001", 8791);
    assert.ok(options);
    assert.equal(options.hostname, "127.0.0.1");
    const server = serve({ ...options, port: 0, fetch: () => new Response("ok") });
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const port = address.port;
      for (const [version, cipher] of [
        ["TLSv1.2", "ECDHE-RSA-AES256-GCM-SHA384"],
        ["TLSv1.3", "TLS_AES_256_GCM_SHA384"],
      ] as const) {
        const result = await new Promise<{ protocol: string | null; cipher: string; body: string }>(
          (resolve, reject) => {
            const request = httpsGet(
              {
                hostname: "127.0.0.1",
                port,
                path: "/",
                servername: "localhost",
                rejectUnauthorized: false,
                minVersion: version,
                maxVersion: version,
                ciphers: cipher,
                agent: false,
              },
              (response) => {
                const socket = response.socket as TLSSocket;
                const protocol = socket.getProtocol();
                const negotiatedCipher = socket.getCipher().name;
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () =>
                  resolve({
                    protocol,
                    cipher: negotiatedCipher,
                    body: Buffer.concat(chunks).toString(),
                  }),
                );
              },
            );
            request.on("error", reject);
          },
        );
        assert.equal(result.protocol, version);
        assert.equal(result.cipher, cipher);
        assert.equal(result.body, "ok");
      }
      for (const [version, cipher] of [
        ["TLSv1.2", "ECDHE-RSA-AES128-GCM-SHA256"],
        ["TLSv1.3", "TLS_AES_128_GCM_SHA256"],
      ] as const) {
        await assert.rejects(
          new Promise<void>((resolve, reject) => {
            const socket = connect({
              host: "127.0.0.1",
              port,
              servername: "localhost",
              rejectUnauthorized: false,
              minVersion: version,
              maxVersion: version,
              ciphers: cipher,
            });
            socket.once("secureConnect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("error", reject);
          }),
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
