const MAX_SERIALIZABLE_ATTEMPTS = 3;

export async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2034"
        ) ||
        attempt >= MAX_SERIALIZABLE_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}
