import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it } from "vitest";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

describe("enqueueTeachComputerInput", () => {
  it("runs one bot's input in order and still continues after a rejection", async () => {
    const botId = "chain-order";
    const order: string[] = [];
    const gate = deferred();

    const first = enqueueTeachComputerInput(botId, async () => {
      order.push("first");
      await gate.promise;
      throw new Error("drop");
    });
    const second = enqueueTeachComputerInput(botId, async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first"]);
    gate.resolve();
    await expect(first).rejects.toThrow("drop");
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});
