/** CopilotKit resets local messages on a fresh connection; Oracle owns history. */
export async function restoreSavedMessages<T>(
  connect: () => Promise<unknown>,
  load: () => Promise<T[]>,
  apply: (messages: T[]) => void,
  isCurrent: () => boolean,
) {
  await connect();
  if (!isCurrent()) return;
  const messages = await load();
  if (isCurrent()) apply(messages);
}
