import { Bluetooth, Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import type { MuseApi } from "./api";
import { registerIosPush } from "./device-registration";
import { colors } from "./ui";
import { endVoiceCallInParallel } from "./voice-cleanup";
import { VoiceCallHealth } from "./voice-health";
import { canAnswerInvitation, type VoiceInvitation } from "./voice-invitation";
import { createVoiceTransport, type VoiceTransport } from "./voice-transport";
import { type VoipEvent, voip } from "./voip";

type Call = {
  id: string;
  threadId?: string;
  incoming: boolean;
  answered: boolean;
  phase: "ringing" | "connecting" | "connected" | "reconnecting";
};

type VoiceSession = { sessionId: string; sdp: string; callId: string; threadId?: string };
type RetryCall = { threadId?: string; reason: string };

function newCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function waitForCallAudio() {
  if (!voip.supported) return;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await voip.isAudioActivated()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("iPhone call audio did not activate.");
}

export function VoiceCallWidget({
  api,
  agentName,
  threadId,
  notify,
  onNotificationOpen,
}: {
  api: MuseApi;
  agentName: string;
  threadId?: string;
  notify: (message: string) => void;
  onNotificationOpen: (data: Record<string, unknown>) => void;
}) {
  const [call, setCall] = useState<Call | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [bluetooth, setBluetooth] = useState(false);
  const [retry, setRetry] = useState<RetryCall | null>(null);
  const current = useRef<Call | null>(null);
  const transport = useRef<VoiceTransport | null>(null);
  const health = useRef<{ callId: string; monitor: VoiceCallHealth } | null>(null);
  const sessionId = useRef<string | null>(null);
  const connecting = useRef(false);
  const onOpenRef = useRef(onNotificationOpen);
  onOpenRef.current = onNotificationOpen;

  const update = useCallback((next: Call | null) => {
    current.current = next;
    setCall(next);
  }, []);

  const finish = useCallback(
    async (requestNativeEnd: boolean, retryReason?: string) => {
      const previous = current.current;
      if (!previous) return;
      void voip.recordStage(previous.id, "js_finish_started").catch(() => {});
      update(null);
      setRetry(retryReason ? { threadId: previous.threadId, reason: retryReason } : null);
      connecting.current = false;
      health.current?.monitor.stop();
      health.current = null;
      transport.current?.close();
      transport.current = null;
      const id = sessionId.current;
      sessionId.current = null;
      setMuted(false);
      setSpeaker(false);
      setBluetooth(false);
      await endVoiceCallInParallel(
        () => (requestNativeEnd && voip.supported ? voip.endCall(previous.id) : Promise.resolve()),
        async () => {
          if (previous.incoming && !previous.answered) {
            await api
              .request(`/api/voice/calls/${encodeURIComponent(previous.id)}/decline`, {}, "POST")
              .catch(() => {});
          } else {
            await api
              .request(`/api/voice/calls/${encodeURIComponent(previous.id)}/end`, {}, "POST")
              .catch(async () => {
                if (id)
                  await api
                    .request(`/api/voice/sessions/${encodeURIComponent(id)}`, undefined, "DELETE")
                    .catch(() => {});
              });
          }
        },
      );
      void voip.recordStage(previous.id, "js_finish_complete").catch(() => {});
    },
    [api, update],
  );

  const connect = useCallback(
    async (target: Call) => {
      if (connecting.current || current.current?.id !== target.id) return;
      connecting.current = true;
      update({ ...target, phase: "connecting", answered: true });
      let media: VoiceTransport | null = null;
      try {
        void voip.recordStage(target.id, "js_audio_wait_start").catch(() => {});
        await waitForCallAudio();
        void voip.recordStage(target.id, "js_audio_wait_ready").catch(() => {});
        if (current.current?.id !== target.id) return;
        media = await createVoiceTransport(target.id);
        if (current.current?.id !== target.id) {
          media.close();
          return;
        }
        transport.current = media;
        const monitor = new VoiceCallHealth({
          onReconnecting: () => {
            const active = current.current;
            if (active?.id === target.id) update({ ...active, phase: "reconnecting" });
          },
          onRecovered: () => {
            const active = current.current;
            if (active?.id === target.id) update({ ...active, phase: "connected" });
          },
          onEnded: (reason) => {
            if (current.current?.id === target.id) void finish(true, reason);
          },
        });
        health.current = { callId: target.id, monitor };
        media.onHealthChange((state) => {
          if (health.current?.callId === target.id) monitor.media(state);
        });
        if (current.current?.id !== target.id) return;
        void voip.recordStage(target.id, "js_session_request").catch(() => {});
        const session = await api.request<VoiceSession>("/api/voice/sessions", {
          sdp: media.offer,
          threadId: target.threadId,
          callId: target.id,
        });
        void voip.recordStage(target.id, "js_session_response").catch(() => {});
        sessionId.current = session.sessionId;
        if (current.current?.id !== target.id) {
          media.close();
          await api
            .request(
              `/api/voice/sessions/${encodeURIComponent(session.sessionId)}`,
              undefined,
              "DELETE",
            )
            .catch(() => {});
          return;
        }
        await media.accept(session.sdp);
        void voip.recordStage(target.id, "js_media_ready").catch(() => {});
        if (current.current?.id !== target.id) return;
        if (voip.supported) await voip.reportConnected(target.id);
        update({
          ...target,
          phase: "connected",
          answered: true,
          threadId: session.threadId || target.threadId,
        });
        monitor.start();
        const bluetoothAvailable = await voip.hasBluetooth();
        if (current.current?.id === target.id) setBluetooth(bluetoothAvailable);
      } catch (error) {
        void voip.recordStage(target.id, "js_connect_error").catch(() => {});
        media?.close();
        if (current.current?.id === target.id) {
          const reason = error instanceof Error ? error.message : String(error);
          notify(`Call could not connect: ${reason}`);
          await finish(true, reason);
        }
      } finally {
        connecting.current = false;
        void voip.recordStage(target.id, "js_connect_finished").catch(() => {});
      }
    },
    [api, finish, notify, update],
  );

  const answer = useCallback(
    async (target: Call) => {
      void voip.recordStage(target.id, "js_answer_received").catch(() => {});
      if (target.answered || current.current?.id !== target.id) return;
      try {
        // A stale or withdrawn push must not start a microphone session.
        const invitation = await api.request<VoiceInvitation>(
          `/api/voice/calls/${encodeURIComponent(target.id)}`,
        );
        if (current.current?.id !== target.id) return;
        if (!canAnswerInvitation(invitation))
          throw new Error("This call has expired or was already handled.");
        void voip.recordStage(target.id, "js_answer_request").catch(() => {});
        await api.request(`/api/voice/calls/${encodeURIComponent(target.id)}/answer`, {}, "POST");
        void voip.recordStage(target.id, "js_answer_response").catch(() => {});
        if (current.current?.id !== target.id) return;
        await connect({ ...target, answered: true });
      } catch (error) {
        if (current.current?.id === target.id) {
          notify(`Call unavailable: ${error instanceof Error ? error.message : String(error)}`);
          await finish(true);
        }
      }
    },
    [api, connect, finish, notify],
  );

  const event = useCallback(
    (value: VoipEvent) => {
      if (value.type === "incoming" && value.callId) {
        if (current.current?.id === value.callId) return;
        const next: Call = {
          id: value.callId,
          threadId: value.threadId,
          incoming: true,
          answered: false,
          phase: "ringing",
        };
        update(next);
      } else if (value.type === "answer" && value.callId) {
        const active =
          current.current?.id === value.callId
            ? current.current
            : {
                id: value.callId,
                threadId: value.threadId,
                incoming: true,
                answered: false,
                phase: "ringing" as const,
              };
        if (current.current?.id !== value.callId) update(active);
        void answer(active);
      } else if (value.type === "end" && value.callId === current.current?.id) {
        void finish(false);
      } else if (value.type === "mute" && value.callId === current.current?.id) {
        const next = !!value.muted;
        transport.current?.mute(next);
        setMuted(next);
      } else if (value.type === "callError" && value.message) {
        notify(value.message);
      }
    },
    [answer, finish, notify, update],
  );

  useEffect(() => {
    const subscription = voip.subscribe(event);
    let active = true;
    void voip.drainEvents().then((events) => {
      if (active) events.forEach(event);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [event]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let active = true;
    void registerIosPush(api, notify, (data) => onOpenRef.current(data))
      .then((stop) => {
        if (active) dispose = stop;
        else stop();
      })
      .catch((error) => notify(`Push notifications unavailable: ${String(error)}`));
    return () => {
      active = false;
      dispose?.();
    };
  }, [api, notify]);

  const activeCallId =
    call?.phase === "connected" || call?.phase === "reconnecting" ? call.id : undefined;
  useEffect(() => {
    if (!activeCallId) return;
    let stopped = false;
    let nextPoll: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      let timedOut = false;
      deadline = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        if (!stopped && current.current?.id === activeCallId) health.current?.monitor.server(false);
      }, 5000);
      try {
        const state = await api.request<{ status: string }>(
          `/api/voice/calls/${encodeURIComponent(activeCallId)}`,
          undefined,
          undefined,
          controller.signal,
        );
        if (stopped || timedOut || current.current?.id !== activeCallId) return;
        if (["ended", "failed", "expired", "declined"].includes(state.status)) {
          void finish(true, `Voice session ${state.status}. Start a new call to continue.`);
          return;
        }
        health.current?.monitor.server(true);
      } catch {
        if (!stopped && current.current?.id === activeCallId) health.current?.monitor.server(false);
      } finally {
        if (deadline) clearTimeout(deadline);
        if (!stopped && current.current?.id === activeCallId)
          nextPoll = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (nextPoll) clearTimeout(nextPoll);
      if (deadline) clearTimeout(deadline);
      controller?.abort();
    };
  }, [activeCallId, api, finish]);

  const start = async (requestedThreadId = threadId) => {
    if (current.current) return;
    setRetry(null);
    const next: Call = {
      id: newCallId(),
      threadId: requestedThreadId,
      incoming: false,
      answered: true,
      phase: "connecting",
    };
    update(next);
    const stillCurrent = () => current.current?.id === next.id;
    try {
      const status = await api.request<{ configured: boolean }>("/api/voice/status");
      if (!status.configured) throw new Error("Voice has not been configured on Oracle yet.");
      if (!stillCurrent()) return;
      if (voip.supported) await voip.startOutgoing(next.id, agentName);
      if (!stillCurrent()) {
        if (voip.supported) await voip.endCall(next.id).catch(() => {});
        return;
      }
      await connect(next);
    } catch (error) {
      if (stillCurrent()) {
        const reason = error instanceof Error ? error.message : String(error);
        notify(`Call could not start: ${reason}`);
        await finish(true, reason);
      }
    }
  };

  const toggleMute = async () => {
    if (!call) return;
    const next = !muted;
    transport.current?.mute(next);
    setMuted(next);
    if (voip.supported) await voip.setMuted(call.id, next).catch((error) => notify(String(error)));
  };

  const toggleSpeaker = async () => {
    const next = !speaker;
    await voip
      .setSpeaker(next)
      .then(() => setSpeaker(next))
      .catch((error) => notify(String(error)));
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Call ${agentName}`}
        onPress={() => void start()}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Phone size={21} color={colors.text} />
      </Pressable>
      <Modal
        visible={!!call || !!retry}
        transparent
        animationType="fade"
        onRequestClose={() => (retry ? setRetry(null) : void finish(true))}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "#10242CEB",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Text style={{ color: "#FFF", fontSize: 28, fontWeight: "600" }}>{agentName}</Text>
          <Text
            style={{
              color: "#D9E6E8",
              marginTop: 8,
              marginBottom: 36,
              textAlign: "center",
            }}
          >
            {retry
              ? retry.reason
              : call?.phase === "ringing"
                ? "Incoming call"
                : call?.phase === "connecting"
                  ? "Connecting…"
                  : call?.phase === "reconnecting"
                    ? "Reconnecting…"
                    : "On call"}
          </Text>
          {(call?.phase === "connecting" || call?.phase === "reconnecting") && (
            <ActivityIndicator color="#FFF" style={{ marginBottom: 22 }} />
          )}
          <View style={{ flexDirection: "row", gap: 26, alignItems: "center" }}>
            {retry ? (
              <>
                <CallControl
                  label="Call again"
                  icon={Phone}
                  color="#2EAF72"
                  onPress={() => void start(retry.threadId)}
                />
                <CallControl
                  label="Dismiss"
                  icon={PhoneOff}
                  color="#445C64"
                  onPress={() => setRetry(null)}
                />
              </>
            ) : call?.incoming && !call.answered ? (
              <CallControl
                label="Answer"
                icon={Phone}
                color="#2EAF72"
                onPress={() => void (voip.supported ? voip.answerCall(call.id) : answer(call))}
              />
            ) : (
              <>
                <CallControl
                  label={muted ? "Unmute" : "Mute"}
                  icon={muted ? MicOff : Mic}
                  color="#445C64"
                  onPress={() => void toggleMute()}
                />
                <CallControl
                  label={speaker ? "Earpiece" : "Speaker"}
                  icon={speaker ? VolumeX : Volume2}
                  color="#445C64"
                  onPress={() => void toggleSpeaker()}
                />
                {bluetooth && (
                  <CallControl
                    label="Bluetooth"
                    icon={Bluetooth}
                    color="#445C64"
                    onPress={() =>
                      void voip.selectBluetooth().catch((error) => notify(String(error)))
                    }
                  />
                )}
              </>
            )}
            <CallControl
              label={call?.incoming && !call.answered ? "Decline" : "Hang up"}
              icon={PhoneOff}
              color="#CB4D4D"
              onPress={() => void finish(true)}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

function CallControl({
  label,
  icon: Icon,
  color,
  onPress,
}: {
  label: string;
  icon: typeof Phone;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ alignItems: "center", gap: 8 }}
    >
      <View
        style={{
          width: 58,
          height: 58,
          borderRadius: 29,
          backgroundColor: color,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={25} color="#FFF" />
      </View>
      <Text style={{ color: "#FFF", fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}
