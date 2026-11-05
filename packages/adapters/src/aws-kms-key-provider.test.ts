import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type * as KmsSdk from "@aws-sdk/client-kms";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AwsKmsKeyProvider } from "./aws-kms-key-provider.js";

const kms = vi.hoisted(() => ({ endpoint: "" }));

// Keeps the provider's client settings, pointed at a local KMS that never answers and with a
// shorter request limit so the test stays fast.
vi.mock("@aws-sdk/client-kms", async (importOriginal) => {
  const sdk = await importOriginal<typeof KmsSdk>();
  class KMSClient extends sdk.KMSClient {
    constructor(config: KmsSdk.KMSClientConfig) {
      const requestHandler = config.requestHandler as Record<string, unknown>;
      super({
        ...config,
        endpoint: kms.endpoint,
        maxAttempts: 1,
        requestHandler: { ...requestHandler, requestTimeout: 200 },
      });
    }
  }
  return { ...sdk, KMSClient };
});

const silent = createServer(() => {
  // Accepts the request and never answers.
});

beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  kms.endpoint = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});

afterAll(async () => {
  silent.closeAllConnections();
  await new Promise((resolve) => silent.close(resolve));
});

it("gives up on a KMS that stops answering instead of waiting forever", async () => {
  const provider = new AwsKmsKeyProvider({
    keyArn: "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });

  await expect(
    provider.wrap(new Uint8Array(32), { spaceId: "space-1", version: 1 }),
  ).rejects.toThrow(/requestTimeout/);
}, 3_000);
