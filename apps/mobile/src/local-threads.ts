import { useCallback, useEffect, useState } from "react";
import type { MuseApi } from "./api";

type SavedThread = {
  id: string;
  name: string | null;
  archived: boolean;
  updatedAt: string;
};

/** Local Oracle thread metadata; the hosted Intelligence thread API is not used. */
export function useLocalThreads(api: MuseApi, enabled: boolean) {
  const [threads, setThreads] = useState<SavedThread[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setLoading] = useState(enabled);
  const [isMutating, setMutating] = useState(false);
  const refetchThreads = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.request<{ threads: SavedThread[] }>(
        "/api/copilotkit/threads?agentId=default&includeArchived=true&limit=100",
      );
      setThreads(result.threads);
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      setLoading(false);
    }
  }, [api, enabled]);
  useEffect(() => {
    void refetchThreads();
  }, [refetchThreads]);

  const mutate = async (path: string, body: unknown, method: string) => {
    setMutating(true);
    try {
      await api.request(path, body, method);
      await refetchThreads();
    } finally {
      setMutating(false);
    }
  };
  return {
    threads,
    error,
    isLoading,
    isMutating,
    refetchThreads,
    renameThread: (id: string, name: string) =>
      mutate(`/api/copilotkit/threads/${encodeURIComponent(id)}`, { name }, "PATCH"),
    archiveThread: (id: string) =>
      mutate(`/api/copilotkit/threads/${encodeURIComponent(id)}/archive`, {}, "POST"),
    unarchiveThread: (id: string) =>
      mutate(`/api/copilotkit/threads/${encodeURIComponent(id)}`, { archived: false }, "PATCH"),
  };
}
