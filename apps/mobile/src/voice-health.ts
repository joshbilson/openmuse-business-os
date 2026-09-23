export type VoiceTransportHealth =
  | { state: "connected" | "disconnected" }
  | { state: "ended"; reason: string };

type Callbacks = {
  onReconnecting(): void;
  onRecovered(): void;
  onEnded(reason: string): void;
};

/** A brief transport or Oracle outage may recover without starting a new session. */
export class VoiceCallHealth {
  private mediaConnected = false;
  private serverReachable = true;
  private started = false;
  private stopped = false;
  private reconnecting = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly callbacks: Callbacks,
    private readonly graceMs = 15000,
    private readonly schedule: (
      callback: () => void,
      delay: number,
    ) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  start() {
    if (this.stopped) return;
    this.started = true;
    this.assess();
  }

  media(health: VoiceTransportHealth) {
    if (this.stopped) return;
    if (health.state === "ended") {
      this.end(health.reason);
      return;
    }
    this.mediaConnected = health.state === "connected";
    this.assess();
  }

  server(reachable: boolean) {
    if (this.stopped) return;
    this.serverReachable = reachable;
    this.assess();
  }

  stop() {
    this.stopped = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private assess() {
    if (!this.started || this.stopped) return;
    if (this.mediaConnected && this.serverReachable) {
      if (this.timer !== undefined) this.cancel(this.timer);
      this.timer = undefined;
      if (this.reconnecting) {
        this.reconnecting = false;
        this.callbacks.onRecovered();
      }
      return;
    }
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.callbacks.onReconnecting();
    }
    this.timer ??= this.schedule(
      () => this.end("Voice connection was lost. Start a new call to continue."),
      this.graceMs,
    );
  }

  private end(reason: string) {
    if (this.stopped) return;
    this.stop();
    this.callbacks.onEnded(reason);
  }
}
