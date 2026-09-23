import type { VoiceTransportHealth } from "./voice-health";
import type { VoiceTransport } from "./voice-transport.native";

export type { VoiceTransport };

export async function createVoiceTransport(): Promise<VoiceTransport> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("This browser cannot start a voice call.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const peer = new RTCPeerConnection();
  let closed = false;
  let listener: ((health: VoiceTransportHealth) => void) | undefined;
  let latest: VoiceTransportHealth | undefined;
  const emit = (health: VoiceTransportHealth) => {
    if (closed || latest?.state === health.state || latest?.state === "ended") return;
    latest = health;
    listener?.(health);
  };
  const peerHealth = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed")
      emit({ state: "ended", reason: "Voice network connection failed." });
    else if (peer.iceConnectionState === "failed" || peer.iceConnectionState === "closed")
      emit({ state: "ended", reason: "Voice network connection failed." });
    else if (peer.connectionState === "disconnected" || peer.iceConnectionState === "disconnected")
      emit({ state: "disconnected" });
    else if (peer.connectionState === "connected") emit({ state: "connected" });
  };
  peer.addEventListener("connectionstatechange", peerHealth);
  peer.addEventListener("iceconnectionstatechange", peerHealth);
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.style.display = "none";
  document.body.appendChild(audio);
  try {
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    const channel = peer.createDataChannel("oai-events");
    channel.addEventListener("close", () =>
      emit({ state: "ended", reason: "Voice control channel closed." }),
    );
    channel.addEventListener("error", () =>
      emit({ state: "ended", reason: "Voice control channel failed." }),
    );
    channel.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        if (JSON.parse(event.data)?.type === "session.closed")
          emit({ state: "ended", reason: "The voice session ended." });
      } catch {
        // Other provider events are not needed for transport health.
      }
    });
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0];
    };
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise<void>((resolve, reject) => {
      if (peer.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const timeout = setTimeout(() => reject(new Error("Voice network setup timed out.")), 15000);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Could not prepare the voice connection.");
    return {
      offer: sdp,
      accept: async (answer) => {
        const connected = new Promise<void>((resolve, reject) => {
          if (peer.connectionState === "connected") {
            resolve();
            return;
          }
          const timeout = setTimeout(() => reject(new Error("Voice connection timed out.")), 20000);
          peer.addEventListener("connectionstatechange", () => {
            if (peer.connectionState === "connected") {
              clearTimeout(timeout);
              resolve();
            } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
              clearTimeout(timeout);
              reject(new Error("Voice network connection failed."));
            }
          });
        });
        const controlReady = new Promise<void>((resolve, reject) => {
          if (channel.readyState === "open") return resolve();
          const done = (error?: Error) => {
            clearTimeout(timeout);
            channel.removeEventListener("open", open);
            channel.removeEventListener("close", lost);
            channel.removeEventListener("error", lost);
            if (error) reject(error);
            else resolve();
          };
          const open = () => done();
          const lost = () => done(new Error("Voice control channel closed."));
          const timeout = setTimeout(
            () => done(new Error("Voice control channel timed out.")),
            20000,
          );
          channel.addEventListener("open", open);
          channel.addEventListener("close", lost);
          channel.addEventListener("error", lost);
        });
        await Promise.all([
          peer.setRemoteDescription({ type: "answer", sdp: answer }),
          connected,
          controlReady,
        ]);
        peerHealth();
      },
      onHealthChange: (next) => {
        listener = next;
        if (latest) next(latest);
      },
      mute: (muted) => {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        });
      },
      close: () => {
        closed = true;
        listener = undefined;
        for (const track of stream.getTracks()) track.stop();
        channel.close();
        peer.close();
        audio.remove();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    peer.close();
    audio.remove();
    throw error;
  }
}
