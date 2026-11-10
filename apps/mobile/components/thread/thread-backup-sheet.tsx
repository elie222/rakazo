import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { captureApiRequestContext, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { WebdavBackupAccount } from "../../lib/webdav-backup";
import {
  buildBackupManifest,
  decideSync,
  ensureWebdavDirectory,
  getWebdavTextFile,
  isBackupPasswordBreached,
  listWebdavDirectory,
  normalizeWebdavServerUrl,
  parseBackupManifest,
  putWebdavTextFile,
  sanitizeBackupDirectory,
  testWebdavConnection,
  validateBackupPassword,
  WEBDAV_BACKUP_MANIFEST_NAME,
  WEBDAV_BACKUP_SETTINGS_NAME,
  WEBDAV_BACKUP_ZIP_NAME,
  WebdavBackupError,
  webdavUrl,
} from "../../lib/webdav-backup";
import {
  loadWebdavBackupAccount,
  loadWebdavBackupSyncState,
  saveWebdavBackupAccount,
  saveWebdavBackupSyncState,
} from "../../lib/webdav-backup-account";
import { applyBackupSettingsFile, readBackupSettingsFile } from "../../lib/webdav-backup-settings";
import {
  downloadAccountExport,
  downloadFileFromWebdav,
  importAccountZip,
  uploadFileToWebdav,
} from "../../lib/webdav-backup-transfer";
import { useIdentityConfirmation } from "../confirm-identity";
import { NativeActionButton } from "../native-action-button";
import { NativeSheet, useNativeSheet } from "../native-sheet";
import { NativeSymbol } from "../native-symbol";

/**
 * Backup settings, in the same in-page sheet style as the background
 * settings: no navigation, a Cancel button up top, closed from here.
 *
 * The backup password is never stored — it lives in state only while an
 * upload or a restore runs, and is cleared the moment the operation ends
 * or the sheet closes. It never enters a log, a URL, or an error message:
 * failures report fixed codes, never values.
 *
 * What the sheet says plainly, because the design requires it:
 * the backup file itself is not encrypted, only the provider keys inside
 * it are; a lost backup password means the keys are gone for good; a
 * restore imports as a new copy and never overwrites; sync v1 is manual.
 */

type Busy = "testing" | "uploading" | "downloading" | "syncing" | null;

export function ThreadBackupSheet({
  visible,
  userId,
  botId,
  onClose,
}: {
  visible: boolean;
  userId: string;
  botId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const Sheet = useNativeSheet();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [directory, setDirectory] = useState("");
  const [hasAccount, setHasAccount] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  // Sync hands off to upload/download in the same tick, so the guard reads a
  // ref: state has not re-rendered yet when the handoff runs.
  const busyRef = useRef<Busy>(null);
  const setBusyState = useCallback((next: Busy) => {
    busyRef.current = next;
    setBusy(next);
  }, []);
  const [progress, setProgress] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const loadedFor = useRef("");

  const clearSecrets = useCallback(() => {
    setBackupPassword("");
    setConfirmPassword("");
    setRestorePassword("");
  }, []);

  const close = useCallback(() => {
    clearSecrets();
    onClose();
  }, [clearSecrets, onClose]);

  useEffect(() => {
    if (!visible || loadedFor.current === userId) return;
    loadedFor.current = userId;
    void (async () => {
      const [account, sync] = await Promise.all([
        loadWebdavBackupAccount(userId),
        loadWebdavBackupSyncState(userId),
      ]);
      if (account) {
        setServerUrl(account.serverUrl);
        setUsername(account.username);
        setAccountPassword(account.password);
        setDirectory(account.directory);
        setHasAccount(true);
      }
      if (sync) setLastSyncedAt(sync.lastSyncedAt);
    })();
  }, [visible, userId]);

  if (!visible || Sheet === undefined) return null;

  function messageForCode(code: string): string {
    switch (code) {
      case "https-required":
        return t("Use an https address.");
      case "invalid-url":
        return t("That server address is not valid.");
      case "credentials-in-url":
        return t("Put the account and password in their own fields, not in the address.");
      case "invalid-directory":
        return t("The directory is not valid.");
      case "auth":
        return t("Wrong password");
      case "parent-missing":
        return t("A parent directory is missing on the server.");
      case "not-found":
        return t("No backup found on the server.");
      case "export-expired":
        return t("The export link expired. Try again.");
      case "unreachable":
        return t("Could not reach the server");
      default:
        return t("Something went wrong. Try again.");
    }
  }

  function report(error: unknown): void {
    if (error instanceof WebdavBackupError) {
      setError(messageForCode(error.code));
      return;
    }
    setError(t("Something went wrong. Try again."));
  }

  // accountFromFields already validated the directory; this keeps the
  // narrowed segments for callers TypeScript cannot narrow through it.
  function directorySegments(account: WebdavBackupAccount): string[] {
    const clean = sanitizeBackupDirectory(account.directory);
    if (!clean.ok) throw new WebdavBackupError(clean.error);
    return clean.segments;
  }

  function accountFromFields(): WebdavBackupAccount | null {
    const normalized = normalizeWebdavServerUrl(serverUrl);
    if (!normalized.ok) {
      setError(messageForCode(normalized.error));
      return null;
    }
    const clean = sanitizeBackupDirectory(directory);
    if (!clean.ok) {
      setError(messageForCode(clean.error));
      return null;
    }
    if (!username.trim() || !accountPassword) {
      setError(t("Set up the WebDAV account first."));
      return null;
    }
    return {
      serverUrl: normalized.serverUrl,
      username: username.trim(),
      password: accountPassword,
      directory: clean.segments.join("/"),
    };
  }

  async function persistAccount(): Promise<WebdavBackupAccount | null> {
    const account = accountFromFields();
    if (!account) return null;
    try {
      await saveWebdavBackupAccount(userId, account);
      setHasAccount(true);
      return account;
    } catch {
      setError(t("Something went wrong. Try again."));
      return null;
    }
  }

  async function testConnection(): Promise<void> {
    const account = accountFromFields();
    if (!account || busyRef.current) return;
    setBusyState("testing");
    setError(null);
    setStatus(null);
    try {
      const result = await testWebdavConnection(account);
      if (result.status === "ok") setStatus(t("Connected"));
      else if (result.status === "auth-error") setError(t("Wrong password"));
      else if (result.status === "missing-directory")
        setStatus(t("Signed in, but the backup directory does not exist yet."));
      else if (result.status === "unreachable") setError(t("Could not reach the server"));
      else setError(t("The server answered with an error."));
    } finally {
      setBusyState(null);
    }
  }

  async function checkBackupPassword(): Promise<string | null> {
    const problem = validateBackupPassword(backupPassword, accountPassword);
    if (problem === "too-short") {
      setError(t("At least 12 characters (16 recommended)"));
      return null;
    }
    if (problem === "same-as-account") {
      setError(t("Use a different password from your account password."));
      return null;
    }
    if (confirmPassword !== backupPassword) {
      setError(t("Passwords do not match"));
      return null;
    }
    if (await isBackupPasswordBreached(backupPassword)) {
      setError(t("This password appeared in a data breach. Choose another."));
      return null;
    }
    return backupPassword;
  }

  async function runUpload(): Promise<void> {
    if (busyRef.current) return;
    const account = await persistAccount();
    if (!account) return;
    const password = await checkBackupPassword();
    if (!password) return;
    setBusyState("uploading");
    setError(null);
    setStatus(null);
    setConflict(false);
    try {
      await ensureWebdavDirectory(account);
      // The export token is one-time and 60 seconds: a failed download
      // spends it, so a retry fetches a fresh token instead of reusing it.
      let downloaded: Awaited<ReturnType<typeof downloadAccountExport>> | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2 && !downloaded; attempt += 1) {
        try {
          const context = await captureApiRequestContext();
          const { token } = await withIdentityConfirmation(() => rpc("export/accountToken"));
          downloaded = await downloadAccountExport({
            apiBase: context.apiBase,
            headers: context.headers,
            accountToken: token,
            backupPassword: password,
            onProgress: (written, total) =>
              setProgress(
                total > 0
                  ? `${t("Downloading…")} ${Math.round((written / total) * 100)}%`
                  : t("Downloading…"),
              ),
          });
        } catch (cause) {
          lastError = cause;
        }
      }
      if (!downloaded) throw lastError ?? new WebdavBackupError("export-failed");
      const manifest = buildBackupManifest({ size: downloaded.size, sha256: downloaded.sha256 });
      const segments = directorySegments(account);
      const normalized = normalizeWebdavServerUrl(account.serverUrl);
      if (!normalized.ok) throw new WebdavBackupError(normalized.error);
      setProgress(t("Uploading…"));
      await uploadFileToWebdav({
        fileUri: downloaded.fileUri,
        url: webdavUrl(normalized.serverUrl, segments, WEBDAV_BACKUP_ZIP_NAME),
        username: account.username,
        password: account.password,
        contentType: "application/zip",
        onProgress: (sent, total) =>
          setProgress(
            total > 0 ? `${t("Uploading…")} ${Math.round((sent / total) * 100)}%` : t("Uploading…"),
          ),
      });
      await putWebdavTextFile(
        account,
        WEBDAV_BACKUP_MANIFEST_NAME,
        JSON.stringify(manifest),
        "application/json",
      );
      const settings = await readBackupSettingsFile(userId);
      await putWebdavTextFile(
        account,
        WEBDAV_BACKUP_SETTINGS_NAME,
        JSON.stringify(settings),
        "application/json",
      );
      const syncedAt = new Date().toISOString();
      await saveWebdavBackupSyncState(userId, { lastSyncedAt: syncedAt, sha256: manifest.sha256 });
      setLastSyncedAt(syncedAt);
      setStatus(t("Backed up"));
    } catch (cause) {
      report(cause);
    } finally {
      setProgress(null);
      setBusyState(null);
      // The backup password only lives in memory for the operation.
      setBackupPassword("");
      setConfirmPassword("");
    }
  }

  async function runDownload(): Promise<void> {
    if (busyRef.current) return;
    const account = await persistAccount();
    if (!account) return;
    // A restore must verify the backup password, the same as an upload:
    // without it the keys stay locked, and a restore with no password at
    // all would hand the whole backup to whoever holds the phone.
    if (!restorePassword) {
      setError(t("Enter the backup password to restore"));
      return;
    }
    setBusyState("downloading");
    setError(null);
    setStatus(null);
    setConflict(false);
    try {
      const names = await listWebdavDirectory(account);
      if (!names.includes(WEBDAV_BACKUP_ZIP_NAME)) {
        throw new WebdavBackupError("not-found");
      }
      const normalized = normalizeWebdavServerUrl(account.serverUrl);
      if (!normalized.ok) throw new WebdavBackupError(normalized.error);
      const segments = directorySegments(account);
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.cache, "webdav-backup");
      if (!directory.exists) directory.create();
      const localZip = new File(directory, "rakazo-backup.zip");
      setProgress(t("Downloading…"));
      const zipUri = await downloadFileFromWebdav({
        url: webdavUrl(normalized.serverUrl, segments, WEBDAV_BACKUP_ZIP_NAME),
        username: account.username,
        password: account.password,
        destinationFileUri: localZip.uri,
      });
      const remoteManifestText = await getWebdavTextFile(account, WEBDAV_BACKUP_MANIFEST_NAME);
      const remoteManifest = remoteManifestText
        ? parseBackupManifest(JSON.parse(remoteManifestText) as unknown)
        : null;
      // The restore password, if one was entered, rides one header to the
      // import route; a wrong one is reported by the server in the result.
      const context = await captureApiRequestContext();
      setProgress(t("Uploading…"));
      const result = await importAccountZip({
        apiBase: context.apiBase,
        headers: context.headers,
        fileUri: zipUri,
        backupPassword: restorePassword,
      });
      const body = result.body as {
        error?: unknown;
        credentials?: { error?: unknown };
      } | null;
      if (body && typeof body.error === "string") {
        setError(body.error);
        return;
      }
      if (body && typeof body.credentials?.error === "string") {
        setError(t("The backup password is wrong."));
        return;
      }
      const settingsText = await getWebdavTextFile(account, WEBDAV_BACKUP_SETTINGS_NAME);
      if (settingsText) {
        try {
          applyBackupSettingsFile(JSON.parse(settingsText) as unknown, userId, botId);
        } catch {
          // A bad settings file never blocks the restore itself.
        }
      }
      const syncedAt = new Date().toISOString();
      await saveWebdavBackupSyncState(userId, {
        lastSyncedAt: syncedAt,
        sha256: remoteManifest?.sha256 ?? null,
      });
      setLastSyncedAt(syncedAt);
      setStatus(t("Restored"));
    } catch (cause) {
      report(cause);
    } finally {
      setProgress(null);
      setBusyState(null);
      setRestorePassword("");
    }
  }

  async function runSync(): Promise<void> {
    if (busyRef.current) return;
    const account = await persistAccount();
    if (!account) return;
    setBusyState("syncing");
    setError(null);
    setStatus(null);
    try {
      const sync = await loadWebdavBackupSyncState(userId);
      const remoteManifestText = await getWebdavTextFile(account, WEBDAV_BACKUP_MANIFEST_NAME);
      const remoteManifest = remoteManifestText
        ? parseBackupManifest(JSON.parse(remoteManifestText) as unknown)
        : null;
      const decision = decideSync(
        sync
          ? { exists: true, updatedAt: sync.lastSyncedAt, size: null, sha256: sync.sha256 }
          : { exists: false, updatedAt: null, size: null, sha256: null },
        remoteManifest
          ? {
              exists: true,
              updatedAt: remoteManifest.exportedAt,
              size: remoteManifest.size,
              sha256: remoteManifest.sha256,
            }
          : { exists: false, updatedAt: null, size: null, sha256: null },
        sync?.lastSyncedAt ?? null,
      );
      if (decision === "nothing") {
        setStatus(t("No backup yet"));
      } else if (decision === "in-sync") {
        setStatus(t("Backup is up to date"));
      } else if (decision === "upload") {
        setBusyState(null);
        await runUpload();
        return;
      } else if (decision === "download") {
        setBusyState(null);
        await runDownload();
        return;
      } else {
        // Both sides changed: never pick a side silently.
        setConflict(true);
        setStatus(t("Sync conflict"));
      }
    } catch (cause) {
      report(cause);
    } finally {
      setBusyState(null);
    }
  }

  const row = (pressed: boolean) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    ...(pressed ? { backgroundColor: tokens.muted } : null),
  });

  const content = (
    <View style={{ backgroundColor: tokens.card, paddingBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: Sheet ? 4 : 12,
          paddingBottom: 8,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
          {t("Backup settings")}
        </Text>
        <NativeActionButton label={t("Cancel")} prominence="plain" onPress={close} />
      </View>
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          lineHeight: 18,
          paddingHorizontal: 20,
          paddingBottom: 4,
        }}
      >
        {t(
          "The backup file itself is not encrypted; only provider keys are encrypted. Keep your WebDAV account safe.",
        )}
      </Text>
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          lineHeight: 18,
          paddingHorizontal: 20,
          paddingBottom: 4,
        }}
      >
        {t(
          "If you lose the backup password, the keys can never be recovered. There is no way to get it back.",
        )}
      </Text>
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          lineHeight: 18,
          paddingHorizontal: 20,
          paddingBottom: 12,
        }}
      >
        {t("Restore imports as a new copy and never overwrites what you already have.")}
      </Text>

      <View style={{ paddingHorizontal: 20, gap: 10, paddingBottom: 8 }}>
        <View>
          <Text style={{ color: tokens.foreground, fontSize: 15, paddingBottom: 4 }}>
            {t("Server address")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <NativeSymbol ios="icloud" android="cloud-outline" size={20} color={tokens.link} />
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://"
              placeholderTextColor={tokens.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: tokens.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tokens.foreground,
                fontSize: 15,
              }}
            />
          </View>
        </View>
        <View>
          <Text style={{ color: tokens.foreground, fontSize: 15, paddingBottom: 4 }}>
            {t("Username")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <NativeSymbol ios="person" android="person-outline" size={20} color={tokens.link} />
            <TextInput
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: tokens.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tokens.foreground,
                fontSize: 15,
              }}
            />
          </View>
        </View>
        <View>
          <Text style={{ color: tokens.foreground, fontSize: 15, paddingBottom: 4 }}>
            {t("Password")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <NativeSymbol ios="key" android="key-outline" size={20} color={tokens.link} />
            <TextInput
              value={accountPassword}
              onChangeText={setAccountPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder={hasAccount ? t("Password set") : undefined}
              placeholderTextColor={tokens.mutedForeground}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: tokens.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tokens.foreground,
                fontSize: 15,
              }}
            />
          </View>
        </View>
        <View>
          <Text style={{ color: tokens.foreground, fontSize: 15, paddingBottom: 4 }}>
            {t("Backup directory")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <NativeSymbol ios="folder" android="folder-outline" size={20} color={tokens.link} />
            <TextInput
              value={directory}
              onChangeText={setDirectory}
              placeholder="rakazo-backup"
              placeholderTextColor={tokens.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: tokens.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tokens.foreground,
                fontSize: 15,
              }}
            />
          </View>
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Test connection")}
        disabled={busy !== null}
        onPress={() => void testConnection()}
        style={({ pressed }) => row(pressed)}
      >
        <NativeSymbol ios="display" android="desktop-outline" size={20} color={tokens.link} />
        <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Test connection")}</Text>
        {busy === "testing" ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 14, marginLeft: "auto" }}>
            {t("Testing…")}
          </Text>
        ) : null}
      </Pressable>

      <View style={{ paddingHorizontal: 20, paddingTop: 12, gap: 10 }}>
        <Text style={{ color: tokens.foreground, fontSize: 16, fontWeight: "600" }}>
          {t("Backup password")}
        </Text>
        <TextInput
          value={backupPassword}
          onChangeText={setBackupPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          placeholder={t("At least 12 characters (16 recommended)")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            borderWidth: 1,
            borderColor: tokens.border,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: tokens.foreground,
            fontSize: 15,
          }}
        />
        <TextInput
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          placeholder={t("Confirm backup password")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            borderWidth: 1,
            borderColor: tokens.border,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: tokens.foreground,
            fontSize: 15,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {t("Use a different password from your account password.")}
        </Text>
        <Text style={{ color: tokens.foreground, fontSize: 16, fontWeight: "600" }}>
          {t("Restore password")}
        </Text>
        <TextInput
          value={restorePassword}
          onChangeText={setRestorePassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          placeholder={t("Enter the backup password to restore")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            borderWidth: 1,
            borderColor: tokens.border,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: tokens.foreground,
            fontSize: 15,
          }}
        />
      </View>

      <View style={{ paddingTop: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Upload")}
          disabled={busy !== null}
          onPress={() => void runUpload()}
          style={({ pressed }) => row(pressed)}
        >
          <NativeSymbol
            ios="arrow.up.doc"
            android="cloud-upload-outline"
            size={20}
            color={tokens.link}
          />
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Upload")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Download")}
          disabled={busy !== null}
          onPress={() => void runDownload()}
          style={({ pressed }) => row(pressed)}
        >
          <NativeSymbol
            ios="arrow.down.doc"
            android="cloud-download-outline"
            size={20}
            color={tokens.link}
          />
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Download")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Sync")}
          disabled={busy !== null}
          onPress={() => void runSync()}
          style={({ pressed }) => row(pressed)}
        >
          <NativeSymbol
            ios="arrow.triangle.2.circlepath"
            android="sync-outline"
            size={20}
            color={tokens.link}
          />
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Sync")}</Text>
        </Pressable>
      </View>
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          lineHeight: 18,
          paddingHorizontal: 20,
          paddingTop: 4,
        }}
      >
        {t("Sync is manual. Nothing uploads or downloads on its own.")}
        {lastSyncedAt
          ? ` ${t("Last synced: {date}", { date: new Date(lastSyncedAt).toLocaleString() })}`
          : ""}
      </Text>
      {conflict ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 12, gap: 8 }}>
          <Text style={{ color: tokens.foreground, fontSize: 15 }}>
            {t("Both sides changed since the last sync. Choose which side to keep.")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Keep this device")}
              disabled={busy !== null}
              onPress={() => void runUpload()}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: tokens.accent,
              }}
            >
              <Text style={{ color: tokens.link, fontSize: 15, fontWeight: "600" }}>
                {t("Keep this device")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Keep the server")}
              disabled={busy !== null}
              onPress={() => void runDownload()}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: tokens.accent,
              }}
            >
              <Text style={{ color: tokens.link, fontSize: 15, fontWeight: "600" }}>
                {t("Keep the server")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {progress ? (
        <Text
          style={{
            color: tokens.mutedForeground,
            fontSize: 13,
            paddingHorizontal: 20,
            paddingTop: 12,
          }}
        >
          {progress}
        </Text>
      ) : null}
      {status ? (
        <Text
          style={{ color: tokens.foreground, fontSize: 14, paddingHorizontal: 20, paddingTop: 12 }}
        >
          {status}
        </Text>
      ) : null}
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.destructive, fontSize: 14, paddingHorizontal: 20, paddingTop: 12 }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );

  if (Sheet) {
    return (
      <>
        <NativeSheet Sheet={Sheet} onClose={close} label={t("Backup settings")}>
          {content}
        </NativeSheet>
        {identityDialog}
      </>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <>
        <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={close}>
          {content}
        </Modal>
        {identityDialog}
      </>
    );
  }
  return (
    <>
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
          {content}
        </View>
      </Modal>
      {identityDialog}
    </>
  );
}
