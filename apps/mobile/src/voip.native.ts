import { requireNativeModule } from "expo";
import { Platform } from "react-native";

export type VoipEvent = {
  type:
    | "token"
    | "tokenInvalidated"
    | "incoming"
    | "answer"
    | "end"
    | "mute"
    | "outgoingStarted"
    | "audioActivated"
    | "audioDeactivated"
    | "callError";
  callId?: string;
  threadId?: string;
  token?: string;
  muted?: boolean;
  expiresAt?: string | number;
  message?: string;
};

export type VoipDiagnosticStage =
  | "js_answer_received"
  | "js_answer_request"
  | "js_answer_response"
  | "js_audio_wait_start"
  | "js_audio_wait_ready"
  | "js_connect_error"
  | "js_connect_finished"
  | "js_mic_request"
  | "js_mic_ready"
  | "js_offer_started"
  | "js_offer_ready"
  | "js_ice_ready"
  | "js_session_request"
  | "js_session_response"
  | "js_media_ready"
  | "js_finish_started"
  | "js_finish_complete";

type VoipModule = {
  addListener: (event: string, listener: (value: VoipEvent) => void) => { remove(): void };
  drainEvents(): Promise<string>;
  getToken(): Promise<string | null>;
  isAudioActivated(): Promise<boolean>;
  recordStage(callId: string, stage: VoipDiagnosticStage): Promise<void>;
  startOutgoing(callId: string, displayName: string): Promise<void>;
  endCall(callId: string): Promise<void>;
  answerCall(callId: string): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  setSpeaker(enabled: boolean): Promise<void>;
  selectBluetooth(): Promise<void>;
  hasBluetooth(): Promise<boolean>;
  reportConnected(callId: string): Promise<void>;
};

const module = Platform.OS === "ios" ? requireNativeModule<VoipModule>("VoipCall") : null;

export const voip = {
  supported: !!module,
  subscribe(listener: (event: VoipEvent) => void) {
    return module?.addListener("onVoipEvent", listener) ?? { remove() {} };
  },
  drainEvents: async (): Promise<VoipEvent[]> =>
    JSON.parse(await (module?.drainEvents() ?? Promise.resolve("[]"))) as VoipEvent[],
  getToken: () => module?.getToken() ?? Promise.resolve(null),
  isAudioActivated: () => module?.isAudioActivated() ?? Promise.resolve(false),
  recordStage: (callId: string, stage: VoipDiagnosticStage) =>
    module?.recordStage(callId, stage) ?? Promise.resolve(),
  startOutgoing: (callId: string, name: string) =>
    module?.startOutgoing(callId, name) ?? Promise.resolve(),
  endCall: (callId: string) => module?.endCall(callId) ?? Promise.resolve(),
  answerCall: (callId: string) => module?.answerCall(callId) ?? Promise.resolve(),
  setMuted: (callId: string, muted: boolean) =>
    module?.setMuted(callId, muted) ?? Promise.resolve(),
  setSpeaker: (enabled: boolean) => module?.setSpeaker(enabled) ?? Promise.resolve(),
  selectBluetooth: () => module?.selectBluetooth() ?? Promise.resolve(),
  hasBluetooth: () => module?.hasBluetooth() ?? Promise.resolve(false),
  reportConnected: (callId: string) => module?.reportConnected(callId) ?? Promise.resolve(),
};
