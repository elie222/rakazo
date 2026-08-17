import { describe, expect, it, vi } from "vitest";
import { withSerializableRetry } from "./serializable-retry.js";

function serializationConflict() {
  return Object.assign(new Error("serialization conflict"), { code: "P2034" });
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

  it("rethrows non-serialization errors without retrying", async () => {
    const error = new Error("unrelated failure");
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
