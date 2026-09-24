import * as SecureStore from "expo-secure-store";

const accessKeyName = "openmuse.ownerAccessKey";

export async function getSavedAccessKey() {
  return SecureStore.getItemAsync(accessKeyName, { keychainService: "openmuse.owner" });
}

export async function saveAccessKey(key: string) {
  await SecureStore.setItemAsync(accessKeyName, key, {
    keychainService: "openmuse.owner",
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}
