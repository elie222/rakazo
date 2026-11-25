import { describe, expect, it } from "vitest";
import { linuxPasswordStore, sealedWithFixedKey } from "./device-token-cipher.js";

describe("linuxPasswordStore", () => {
  it("asks for the Secret Service on desktops Chromium does not recognize", () => {
    expect(linuxPasswordStore({ XDG_CURRENT_DESKTOP: "Hyprland" })).toBe("gnome-libsecret");
  });

  it("leaves KDE on KWallet", () => {
    expect(linuxPasswordStore({ XDG_CURRENT_DESKTOP: "KDE" })).toBeNull();
  });
});

describe("sealedWithFixedKey", () => {
  it("tells the fixed fallback key from a keyring key", () => {
    expect(sealedWithFixedKey(Buffer.from("v10abc"))).toBe(true);
    expect(sealedWithFixedKey(Buffer.from("v11abc"))).toBe(false);
  });
});
