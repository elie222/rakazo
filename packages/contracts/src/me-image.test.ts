import { describe, expect, it } from "vitest";
import { MeSchema } from "./domain.js";
import { appContract } from "./rpc.js";

const IMAGE = "data:image/webp;base64,aGVsbG8=";

const baseMe = {
  ticketBoardEnabled: false,
  userId: "user-1",
  email: "user@rakazo.test",
  name: "Test User",
  spaceId: "space-1",
  isDeploymentOwner: false,
  needsModel: false,
  defaultProvider: null,
  defaultModel: null,
  hostCredentialProvider: null,
  hostCredentialSource: null,
  computerHost: null,
  canChooseHostComputer: false,
  sandboxProvider: "docker",
  avatarStyle: "organic",
  billingEnabled: false,
};

describe("Me image", () => {
  it("accepts a profile photo data URL, null, and absence on older servers", () => {
    expect(MeSchema.parse({ ...baseMe, image: IMAGE }).image).toBe(IMAGE);
    expect(MeSchema.parse({ ...baseMe, image: null }).image).toBeNull();
    expect(MeSchema.parse(baseMe).image).toBeUndefined();
  });

  it("rejects a remote URL as a profile photo", () => {
    expect(MeSchema.safeParse({ ...baseMe, image: "https://example.test/photo.png" }).success).toBe(
      false,
    );
  });
});

describe("preferences update image", () => {
  it("accepts an image-only update and a null clear", () => {
    const schema = appContract.preferences.update["~orpc"].inputSchema;
    if (!schema) throw new Error("missing input schema");
    expect(schema.parse({ image: IMAGE })).toEqual({ image: IMAGE });
    expect(schema.parse({ image: null })).toEqual({ image: null });
  });

  it("rejects an oversized image and an empty update", () => {
    const schema = appContract.preferences.update["~orpc"].inputSchema;
    if (!schema) throw new Error("missing input schema");
    expect(
      schema.safeParse({ image: `data:image/webp;base64,${"x".repeat(200_000)}` }).success,
    ).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
