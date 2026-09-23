import type { VoipEvent } from "./voip.native";

export type { VoipEvent };
export const voip = {
  supported: false,
  subscribe(_listener: (event: VoipEvent) => void) {
    return { remove() {} };
  },
  drainEvents: async (): Promise<VoipEvent[]> => [],
  getToken: async (): Promise<string | null> => null,
  isAudioActivated: async () => false,
  startOutgoing: async (_callId: string, _name: string) => {},
  endCall: async (_callId: string) => {},
  answerCall: async (_callId: string) => {},
  setMuted: async (_callId: string, _muted: boolean) => {},
  setSpeaker: async (_enabled: boolean) => {},
  selectBluetooth: async () => {},
  hasBluetooth: async () => false,
  reportConnected: async (_callId: string) => {},
};
