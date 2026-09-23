import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { MuseApi } from "./api";
import { type VoipEvent, voip } from "./voip";

const deviceKey = "openmuse.deviceId";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function deviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(deviceKey, { keychainService: "openmuse.device" });
  if (id) return id;
  const vendor = await Application.getIosIdForVendorAsync();
  id = `ios-${vendor || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  await SecureStore.setItemAsync(deviceKey, id, {
    keychainService: "openmuse.device",
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  return id;
}

export async function registerIosPush(
  api: MuseApi,
  onError: (error: string) => void,
  onOpen: (data: Record<string, unknown>) => void,
) {
  if (Platform.OS !== "ios") return () => {};
  const id = await deviceId();
  const environment =
    (await Application.getIosPushNotificationServiceEnvironmentAsync()) === "production"
      ? "production"
      : "sandbox";
  const register = async (kind: "alert" | "voip", token: string) => {
    await api.request("/api/devices", {
      deviceId: id,
      platform: "ios",
      token,
      kind,
      environment,
    });
  };
  const onVoip = (event: VoipEvent) => {
    if (event.type === "token" && event.token) {
      void register("voip", event.token).catch((e) => onError(String(e)));
    }
  };
  const voipSubscription = voip.subscribe(onVoip);
  const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    onOpen(response.notification.request.content.data);
  });
  const lastResponse = await Notifications.getLastNotificationResponseAsync();
  if (lastResponse) {
    onOpen(lastResponse.notification.request.content.data);
    await Notifications.clearLastNotificationResponseAsync();
  }
  const token = await voip.getToken();
  if (token) await register("voip", token).catch((e) => onError(String(e)));
  let pushSubscription: { remove(): void } | undefined;
  try {
    const permission = await Notifications.getPermissionsAsync();
    const status = permission.granted ? permission : await Notifications.requestPermissionsAsync();
    if (status.granted) {
      const push = await Notifications.getDevicePushTokenAsync();
      await register("alert", String(push.data)).catch((e) => onError(String(e)));
      pushSubscription = Notifications.addPushTokenListener((next) => {
        void register("alert", String(next.data)).catch((e) => onError(String(e)));
      });
    }
  } catch (error) {
    onError(`Alert notifications unavailable: ${String(error)}`);
  }
  return () => {
    voipSubscription.remove();
    responseSubscription.remove();
    pushSubscription?.remove();
  };
}
