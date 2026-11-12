import { afterEach, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ warn }) }));

import { forgetDeploymentSecret } from "./deployment-secrets.js";

afterEach(() => warn.mockReset());

it("logs a cleanup the secret store refused, without its message, and carries on", async () => {
  const secrets = {
    delete: vi.fn(async () => {
      throw new TypeError("store echoed fixture-ciphertext");
    }),
  };
  await expect(
    forgetDeploymentSecret(secrets, "fixture-ciphertext", "deployment-model:anthropic"),
  ).resolves.toBeUndefined();
  expect(secrets.delete).toHaveBeenCalledWith("fixture-ciphertext", "deployment-model:anthropic");
  expect(warn).toHaveBeenCalledExactlyOnceWith("deployment_secret.cleanup_failed", {
    record: "deployment-model:anthropic",
    "error.name": "TypeError",
  });
});
