import assert from "node:assert/strict";
import { test } from "node:test";
import { assertApiDeploymentConfig, type Config } from "../apps/server/src/config.ts";

const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
};

test("self-hosted API starts without CopilotKit Intelligence credentials", () => {
  assert.doesNotThrow(() => assertApiDeploymentConfig(config));
  assert.doesNotThrow(() =>
    assertApiDeploymentConfig({ ...config, mode: "live", agentBackend: "hermes" }),
  );
});

test("live API rejects legacy model and sample backends", () => {
  for (const backend of ["sample", "model", "agui"] as const)
    assert.throws(
      () => assertApiDeploymentConfig({ ...config, mode: "live", agentBackend: backend }),
      /Hermes agent backend/,
    );
});
