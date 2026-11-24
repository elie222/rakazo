import { app, safeStorage } from "electron";

/** Call before `ready`: the store is chosen once at startup. */
export function chooseLinuxKeyring() {
  if (process.platform !== "linux" || app.commandLine.hasSwitch("password-store")) return;
  const store = linuxPasswordStore(process.env);
  if (store) app.commandLine.appendSwitch("password-store", store);
}

export function deviceTokenCipher() {
  return {
    // Linux without a keyring falls back to a fixed key; keep the token off disk there.
    available: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      !(
        process.platform === "linux" &&
        sealedWithFixedKey(await safeStorage.encryptStringAsync("probe"))
      ),
    encrypt: (value: string) => safeStorage.encryptStringAsync(value),
    decrypt: async (value: Buffer) => (await safeStorage.decryptStringAsync(value)).result,
  };
}

/**
 * Chromium only picks a keyring on desktops it recognizes, so tiling window managers
 * (Hyprland, Sway, i3) fall back to a fixed key even with a Secret Service running.
 * KDE keeps its own choice of KWallet.
 */
export function linuxPasswordStore(env: NodeJS.ProcessEnv): string | null {
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`;
  return /kde|plasma/i.test(desktop) ? null : "gnome-libsecret";
}

/** On Linux, "v10" ciphertext is sealed with Chromium's fixed fallback key, not the keyring. */
export function sealedWithFixedKey(ciphertext: Buffer): boolean {
  return ciphertext.subarray(0, 3).toString("latin1") === "v10";
}
