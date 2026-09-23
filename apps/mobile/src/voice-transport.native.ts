import { mediaDevices, RTCPeerConnection, RTCSessionDescription } from "react-native-webrtc";
import type { VoiceTransportHealth } from "./voice-health";

export type VoiceTransport = {
  offer: string;
  accept(answer: string): Promise<void>;
  onHealthChange(listener: (health: VoiceTransportHealth) => void): void;
  mute(muted: boolean): void;
  close(): void;
};

function waitUntilConnected(peer: RTCPeerConnection) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (peer.connectionState === "connected") {
        clearInterval(timer);
        resolve();
      } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        clearInterval(timer);
        reject(new Error("Voice network connection failed."));
      } else if (Date.now() - started >= 20000) {
        clearInterval(timer);
        reject(new Error("Voice connection timed out."));
      }
    }, 100);
  });
}

function waitUntilChannelOpen(channel: ReturnType<RTCPeerConnection["createDataChannel"]>) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (channel.readyState === "open") {
        clearInterval(timer);
        resolve();
      } else if (channel.readyState === "closed" || channel.readyState === "closing") {
        clearInterval(timer);
        reject(new Error("Voice control channel closed."));
      } else if (Date.now() - started >= 20000) {
        clearInterval(timer);
        reject(new Error("Voice control channel timed out."));
      }
    }, 100);
  });
}

export async function createVoiceTransport(): Promise<VoiceTransport> {
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  const peer = new RTCPeerConnection({ iceServers: [] });
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
  peer.onconnectionstatechange = peerHealth;
  peer.oniceconnectionstatechange = peerHealth;
  try {
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const channel = peer.createDataChannel("oai-events");
    channel.onclose = () => emit({ state: "ended", reason: "Voice control channel closed." });
    channel.onerror = () => emit({ state: "ended", reason: "Voice control channel failed." });
    channel.onmessage = (event: { data: unknown }) => {
      if (typeof event.data !== "string") return;
      try {
        if (JSON.parse(event.data)?.type === "session.closed")
          emit({ state: "ended", reason: "The voice session ended." });
      } catch {
        // Other provider events are not needed for transport health.
      }
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await new Promise<void>((resolve, reject) => {
      if (peer.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const timeout = setTimeout(() => reject(new Error("Voice network setup timed out.")), 15000);
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Could not prepare the voice connection.");
    return {
      offer: sdp,
      accept: async (answer) => {
        const connected = waitUntilConnected(peer);
        const controlReady = waitUntilChannelOpen(channel);
        await Promise.all([
          peer.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: answer })),
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
        for (const track of stream.getAudioTracks()) track.enabled = !muted;
      },
      close: () => {
        closed = true;
        listener = undefined;
        for (const track of stream.getTracks()) track.stop();
        channel.close();
        peer.close();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    peer.close();
    throw error;
  }
}
