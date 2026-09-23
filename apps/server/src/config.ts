import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  agentBackend: "sample" | "hermes" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  hermesModel?: string;
  hermesProvider?: string;
  hermesProfile?: string;
  /** Legacy demo/test-only field; never required by the self-hosted API. */
  intelligenceApiKey?: string;
  actionApprovalMode?: "manual" | "standing-authority";
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  allowedOrigins: string[];
}

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}
/** Kept for the standalone upstream demo, not the business OS server. */
export const intelligenceKeyRequiredMessage =
  "CPK_INTELLIGENCE_API_KEY is required by the upstream demo only";

export function assertApiDeploymentConfig(config: Config): void {
  if (config.mode === "live" && config.agentBackend !== "hermes")
    throw new Error("Live mode requires the Hermes agent backend");
}

export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "hermes");
  if (backend !== "sample" && backend !== "hermes")
    throw new Error("AGENT_BACKEND must be sample or hermes");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    agentBackend: backend,
    agentUrl: process.env.HERMES_API_URL ?? process.env.AGENT_URL,
    agentToken: process.env.HERMES_API_KEY ?? process.env.AGENT_TOKEN,
    hermesModel: process.env.HERMES_MODEL,
    hermesProvider: process.env.HERMES_PROVIDER,
    hermesProfile: process.env.HERMES_PROFILE,
    actionApprovalMode:
      process.env.ACTION_APPROVAL_MODE === "standing-authority" ? "standing-authority" : "manual",
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: process.env.BROWSER_WORKER_URL,
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
  };
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
