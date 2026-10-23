import { describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

const conflict = (code: string) => Object.assign(new Error("transaction failed"), { code });
const driverConflict = (originalCode: string) =>
  Object.assign(new Error("transaction failed"), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });

describe("withTransactionRetry", () => {
  it.each([
    ["a Prisma write conflict or deadlock", conflict("P2034")],
    ["a Postgres deadlock", driverConflict("40P01")],
    ["a Postgres serialization failure", driverConflict("40001")],
  ])("retries %s", async (_, error) => {
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("committed");

    await expect(withTransactionRetry(operation)).resolves.toBe("committed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("gives up after three conflicting attempts", async () => {
    const error = conflict("P2034");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransactionRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry other failures", async () => {
    const error = conflict("P2002");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransactionRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
