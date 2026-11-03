import { notificationAvatarSource } from "@rakazo/core";
import { expect, it } from "vitest";
import { notificationIdentity } from "./notification-identity.js";

it.each(["organic", "rakazo"])("creates a bounded JPEG for the %s avatar", async (avatarSet) => {
  const identity = await notificationIdentity({
    id: "agent-1",
    name: "Head of Marketing",
    color: "#14b8a6",
    avatarSet,
  });
  expect(identity.name).toBe("Head of Marketing");
  const bytes = Buffer.from(identity.avatar!, "base64");
  expect(bytes.length).toBeLessThanOrEqual(1050);
  const { default: sharp } = await import("sharp");
  expect(await sharp(bytes).metadata()).toMatchObject({ width: 40, height: 40, format: "jpeg" });
});

it("uses a saved profile picture, with no external avatar fetch", async () => {
  const { default: sharp } = await import("sharp");
  const original = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const color = `data:image/png;base64,${original.toString("base64")}`;
  expect(notificationAvatarSource({ id: "bot", color })).toBe(color);
  const identity = await notificationIdentity({ id: "bot", name: "Marketing", color });
  const pixel = await sharp(Buffer.from(identity.avatar!, "base64")).raw().toBuffer();
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeLessThan(20);
  expect(
    notificationAvatarSource({ id: "bot", color: "https://untrusted.example/avatar.png" }),
  ).toMatch(/^data:image\/svg\+xml,/);
});
