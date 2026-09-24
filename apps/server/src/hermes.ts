import type { Config } from "./config.ts";

export interface HermesRun {
  run_id: string;
  status: "started" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
  // Hermes v0.21.3 reports the selected request model at the top level.
  model?: string;
  provider?: string;
  output?: string;
  error?: string;
  runtime?: { provider?: string; model?: string };
}

/** One Hermes API-server profile serves both interactive and durable worker turns. */
export class HermesClient {
  constructor(private readonly config: Config) {}
  get configured() {
    return Boolean(
      this.config.agentUrl &&
        this.config.agentToken &&
        this.config.hermesModel &&
        this.config.hermesProvider,
    );
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const agentUrl = this.config.agentUrl;
    if (!this.configured || !agentUrl)
      throw new Error(
        "Hermes is unavailable: configure HERMES_API_URL, HERMES_API_KEY, HERMES_MODEL and HERMES_PROVIDER",
      );
    const endpoint = new URL(path, `${agentUrl.replace(/\/$/, "")}/`);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.agentToken}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Hermes is unavailable. Check the local gateway and its selected profile.");
    }
    if (!response.ok) {
      // Provider error bodies may contain credentials or prompt data; never surface them.
      throw new Error(`Hermes request failed (${response.status}) at ${path}`);
    }
    return response;
  }
  async health(): Promise<boolean> {
    try {
      const response = await this.request("health/detailed");
      const value = (await response.json()) as { status?: string };
      return value.status === "ok" || value.status === "ready";
    } catch {
      return false;
    }
  }
  async start(input: {
    key: string;
    prompt: string;
    sessionId: string;
    instructions?: string;
  }): Promise<HermesRun> {
    if (this.config.hermesProfile) {
      const capabilities = (await (await this.request("v1/capabilities")).json()) as {
        model?: string;
        features?: { run_submission?: boolean; run_status?: boolean; run_stop?: boolean };
      };
      if (
        capabilities.model !== this.config.hermesProfile ||
        !capabilities.features?.run_submission ||
        !capabilities.features.run_status ||
        !capabilities.features.run_stop
      )
        throw new Error(
          "Hermes API does not expose the configured business profile and durable run capabilities",
        );
    }
    const response = await this.request("v1/runs", {
      method: "POST",
      headers: { "Idempotency-Key": input.key },
      body: JSON.stringify({
        input: input.prompt,
        session_id: input.sessionId,
        instructions: input.instructions,
        model: this.config.hermesModel,
        provider: this.config.hermesProvider,
      }),
    });
    const run = (await response.json()) as HermesRun;
    if (!run.run_id) throw new Error("Hermes returned no run ID");
    return run;
  }
  async get(id: string): Promise<HermesRun> {
    const response = await this.request(`v1/runs/${encodeURIComponent(id)}`);
    const run = (await response.json()) as HermesRun;
    if (!run.run_id || !run.status) throw new Error("Hermes returned an invalid run state");
    if (run.status === "completed") {
      const reportedModel = run.runtime?.model ?? run.model;
      const reportedProvider = run.runtime?.provider ?? run.provider;
      if (
        reportedModel !== this.config.hermesModel ||
        (reportedProvider && reportedProvider !== this.config.hermesProvider)
      )
        throw new Error(
          "Hermes reported a different model or provider than the configured profile; no fallback result was accepted",
        );
    }
    return run;
  }
  async stop(id: string): Promise<void> {
    await this.request(`v1/runs/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" });
  }
  async wait(
    id: string,
    signal?: AbortSignal,
    onTick?: (run: HermesRun) => Promise<void>,
  ): Promise<HermesRun> {
    for (;;) {
      signal?.throwIfAborted();
      const run = await this.get(id);
      await onTick?.(run);
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 1000);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
