import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";

export interface PushDevice {
  id: string;
  deviceId: string;
  platform: "ios";
  token: string;
  kind: "alert" | "voip";
  environment: "sandbox" | "production";
  active: boolean;
  registeredAt: string;
}
export interface PushResult {
  accepted: boolean;
  status: number;
  reason?: string;
  invalidToken?: boolean;
  retryable?: boolean;
}
export interface PushSender {
  readonly configured: boolean;
  send(device: PushDevice, payload: Record<string, unknown>, id: string): Promise<PushResult>;
}

/** APNs is the OS transport; credentials and all notification logic stay on this server. */
export class ApnsSender implements PushSender {
  private cachedJwt?: { token: string; created: number };
  constructor(
    private readonly config = {
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
      bundleId: process.env.APNS_BUNDLE_ID,
      keyPath: process.env.APNS_PRIVATE_KEY_PATH,
    },
  ) {}

  get configured() {
    return Boolean(
      this.config.keyId && this.config.teamId && this.config.bundleId && this.config.keyPath,
    );
  }

  private jwt() {
    if (!this.configured || !this.config.keyPath)
      throw new Error("APNs signing credentials are not configured");
    if (this.cachedJwt && Date.now() - this.cachedJwt.created < 45 * 60_000)
      return this.cachedJwt.token;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: this.config.keyId })}.${encode({ iss: this.config.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key: createPrivateKey(readFileSync(this.config.keyPath, "utf8")),
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    this.cachedJwt = { token: `${unsigned}.${signature}`, created: Date.now() };
    return this.cachedJwt.token;
  }

  async send(
    device: PushDevice,
    payload: Record<string, unknown>,
    id: string,
  ): Promise<PushResult> {
    const jwt = this.jwt();
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > (device.kind === "voip" ? 5120 : 4096))
      throw new Error("Push payload is too large");
    return new Promise((resolve) => {
      const client = connect(
        device.environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com",
      );
      let finished = false;
      const finish = (result: PushResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        client.destroy();
        resolve(result);
      };
      const timeout = setTimeout(
        () => finish({ accepted: false, status: 0, reason: "TransportTimeout", retryable: true }),
        10_000,
      );
      client.on("error", () =>
        finish({ accepted: false, status: 0, reason: "TransportError", retryable: true }),
      );
      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": `${this.config.bundleId}${device.kind === "voip" ? ".voip" : ""}`,
        "apns-push-type": device.kind,
        "apns-priority": "10",
        "apns-expiration":
          device.kind === "voip" ? "0" : String(Math.floor(Date.now() / 1000) + 3600),
        "apns-collapse-id": id.slice(0, 64),
      });
      let status = 0;
      let responseBody = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk: string) => {
        if (responseBody.length < 2048) responseBody += chunk;
      });
      request.on("error", () =>
        finish({ accepted: false, status: 0, reason: "TransportError", retryable: true }),
      );
      request.on("end", () => {
        let reason: string | undefined;
        try {
          reason = JSON.parse(responseBody).reason;
        } catch {
          /* Successful responses have no body. */
        }
        finish({
          accepted: status === 200,
          status,
          reason,
          invalidToken:
            status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic",
          retryable: status === 429 || status >= 500,
        });
      });
      request.end(body);
    });
  }
}
