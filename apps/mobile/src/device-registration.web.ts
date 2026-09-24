import type { MuseApi } from "./api";
export async function registerIosPush(
  _api: MuseApi,
  _onError: (error: string) => void,
  _onOpen: (data: Record<string, unknown>) => void,
) {
  return () => {};
}
