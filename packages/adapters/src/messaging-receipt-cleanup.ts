import { getLogger } from "@rakazo/logging";

/** Both normal and late receipts use the same bounded, best-effort deletion policy. */
export async function clearTemporaryReceipt(cleanup: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Messaging receipt cleanup timed out")), 2_000);
        }),
      ]);
      return;
    } catch (error) {
      getLogger().error("messaging receipt error", error);
      if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    } finally {
      clearTimeout(timer);
    }
  }
}
