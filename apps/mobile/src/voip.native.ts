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

type VoipModule = {
  addListener: (event: string, listener: (value: VoipEvent) => void) => { remove(): void };
  drainEvents(): Promise<string>;
  getToken(): Promise<string | null>;
  isAudioActivated(): Promise<boolean>;
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
