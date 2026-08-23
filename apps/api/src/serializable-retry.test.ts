import { describe, expect, it, vi } from "vitest";
import { withSerializableRetry } from "./serializable-retry.js";

function serializationConflict() {
  return Object.assign(new Error("serialization conflict"), { code: "P2034" });
}

function adapterConflict(originalCode: "40001" | "40P01") {
  return Object.assign(new Error("database conflict"), {
    code: "P2039",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });
}

describe("withSerializableRetry", () => {
  it("retries serialization conflicts and returns the successful result", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(serializationConflict())
      .mockRejectedValueOnce(serializationConflict())
      .mockResolvedValue("ok");

    await expect(withSerializableRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each(["40001", "40P01"] as const)(
    "retries driver-adapter transaction conflict %s",
    async (databaseCode) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(adapterConflict(databaseCode))
        .mockResolvedValue("ok");

      await expect(withSerializableRetry(operation)).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    },
  );

  it("rethrows non-serialization errors without retrying", async () => {
    const error = new Error("unrelated failure");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(withSerializableRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry unrelated driver-adapter errors", async () => {
    const error = Object.assign(new Error("external connector error"), { code: "P2039" });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(withSerializableRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rethrows the final serialization conflict after the bounded retry limit", async () => {
    const error = serializationConflict();
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(withSerializableRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
