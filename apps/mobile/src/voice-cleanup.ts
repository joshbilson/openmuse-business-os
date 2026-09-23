/** Start the local CallKit end action without letting it delay Oracle cleanup. */
export async function endVoiceCallInParallel(
  nativeEnd: () => Promise<void>,
  serverEnd: () => Promise<void>,
): Promise<void> {
  try {
    void nativeEnd().catch(() => {});
  } catch {
    // A native bridge error must not leave the Oracle call open.
  }
  await serverEnd();
}
