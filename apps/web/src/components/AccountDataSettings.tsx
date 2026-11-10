import { Trans, useLingui } from "@lingui/react/macro";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { Button, Input, Label, Spinner } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import {
  BACKUP_PASSWORD_HEADER,
  BACKUP_PASSWORD_MIN_LENGTH,
  canSendBackupPassword,
  isBackupPasswordBreached,
  validateBackupPassword,
} from "../lib/backup-password";
import { recheckSessionOnUnauthorized, rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";
import { SettingsRow } from "./SettingsRows";

function exportFilename(contentDisposition: string | null): string {
  const match = /filename="([^"]+)"/.exec(contentDisposition ?? "");
  return match?.[1] ?? `rakazo-export-${new Date().toISOString().slice(0, 10)}.zip`;
}

export function AccountDataSettings({
  onImported,
  onImportAgent,
}: {
  onImported?: () => Promise<void>;
  onImportAgent?: () => void;
}) {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<"export" | "import" | null>(null);
  const [imported, setImported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialWarning, setCredentialWarning] = useState<string | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupPasswordConfirm, setBackupPasswordConfirm] = useState("");

  /**
   * The backup password is never stored: it lives in state only until the
   * request that needs it has been sent, then it is cleared.
   */
  function clearBackupPassword() {
    setBackupPassword("");
    setBackupPasswordConfirm("");
  }

  async function exportErrorText(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    if (!text) return t`Could not continue`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      return text.length < 200 ? text : t`Could not continue`;
    }
    return t`Could not continue`;
  }

  async function exportData() {
    if (pending) return;
    const withPassword = backupPassword.length > 0;
    if (withPassword) {
      const problem = validateBackupPassword(backupPassword, backupPasswordConfirm);
      if (problem === "too-short") {
        setError(t`Use at least ${BACKUP_PASSWORD_MIN_LENGTH} characters for the backup password`);
        return;
      }
      if (problem === "mismatch") {
        setError(t`Backup passwords do not match`);
        return;
      }
      if (!canSendBackupPassword()) {
        setError(t`Backup passwords need an HTTPS connection`);
        return;
      }
      if (await isBackupPasswordBreached(backupPassword)) {
        setError(t`This password appeared in a data breach. Choose another.`);
        return;
      }
    }
    setPending("export");
    setImported(false);
    setError(null);
    setCredentialWarning(null);
    // The password is cleared once the request has been sent, not when
    // identity confirmation is cancelled before anything was sent.
    let sent = false;
    try {
      const { token } = await withIdentityConfirmation(() => rpc.export.accountToken());
      if (!withPassword) {
        // A download link, not a fetch, so the browser or Electron saves the stream natively.
        const link = document.createElement("a");
        link.href = `/api/account/export?token=${encodeURIComponent(token)}`;
        link.download = "";
        link.click();
        return;
      }
      // POST export: the password travels in the body, in the same request
      // as the streamed zip, so the key never lands anywhere. Until the
      // server speaks this route, a password export fails here and the
      // password-free export above keeps working.
      sent = true;
      const response = await fetch("/api/account/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, backupPassword }),
      });
      recheckSessionOnUnauthorized(response.status);
      if (!response.ok) {
        setError(await exportErrorText(response));
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename(response.headers.get("content-disposition"));
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!isIdentityConfirmationRequired(cause)) setError(errorText(cause, t`Could not continue`));
    } finally {
      if (sent) clearBackupPassword();
      setPending(null);
    }
  }

  async function importData(file: File) {
    if (pending) return;
    setPending("import");
    setImported(false);
    setError(null);
    setCredentialWarning(null);
    const withPassword = backupPassword.length > 0;
    try {
      const headers: Record<string, string> = { "content-type": "application/zip" };
      if (withPassword) headers[BACKUP_PASSWORD_HEADER] = backupPassword;
      const response = await fetch("/api/account/import", {
        method: "POST",
        headers,
        credentials: "include",
        body: file,
      });
      recheckSessionOnUnauthorized(response.status);
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        credentials?: { error?: unknown };
      } | null;
      if (!response.ok) {
        setError(typeof body?.error === "string" ? body.error : t`Could not continue`);
        return;
      }
      // A wrong backup password skips only the provider keys; the rest of
      // the import still lands, and the server says so here.
      if (typeof body?.credentials?.error === "string" && body.credentials.error) {
        setCredentialWarning(body.credentials.error);
      }
      await onImported?.().catch(() => undefined);
      setImported(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      if (withPassword) clearBackupPassword();
      setPending(null);
    }
  }

  return (
    <>
      <SettingsRow
        label={<Trans>Your data</Trans>}
        control={
          <>
            {imported ? <SuccessPop label={t`Done`} /> : null}
            <Button
              variant="secondary"
              size="sm"
              aria-label={t`Export data`}
              data-testid="account-export"
              disabled={pending !== null}
              aria-busy={pending === "export"}
              onClick={() => void exportData()}
            >
              {pending === "export" ? <Spinner aria-hidden /> : null}
              <Trans>Export</Trans>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label={t`Import data`}
              data-testid="account-import"
              disabled={pending !== null}
              aria-busy={pending === "import"}
              onClick={() => fileInput.current?.click()}
            >
              {pending === "import" ? <Spinner aria-hidden /> : null}
              <Trans>Import</Trans>
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              hidden
              data-testid="account-import-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importData(file);
              }}
            />
          </>
        }
      >
        {error ? (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        {credentialWarning ? (
          <p role="alert" className="mt-2 text-body-sm text-warning">
            {credentialWarning}
          </p>
        ) : null}
      </SettingsRow>
      <SettingsRow label={<Trans>Backup password</Trans>}>
        <div className="mt-2 max-w-md space-y-2">
          <div className="space-y-2">
            <Label htmlFor="backup-password">
              <Trans>Backup password</Trans>
            </Label>
            <Input
              id="backup-password"
              data-testid="backup-password"
              type="password"
              autoComplete="new-password"
              value={backupPassword}
              disabled={pending !== null}
              onChange={(event) => setBackupPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="backup-password-confirm">
              <Trans>Confirm backup password</Trans>
            </Label>
            <Input
              id="backup-password-confirm"
              data-testid="backup-password-confirm"
              type="password"
              autoComplete="new-password"
              value={backupPasswordConfirm}
              disabled={pending !== null}
              onChange={(event) => setBackupPasswordConfirm(event.target.value)}
            />
          </div>
          <p className="text-body-sm text-muted-foreground">
            <Trans>
              At least 12 characters (16 recommended). Don&apos;t reuse your account password.
            </Trans>
          </p>
          <p className="text-body-sm text-muted-foreground">
            <Trans>
              Only provider keys are encrypted; the backup file itself is not. If you lose this
              password, the keys are gone for good.
            </Trans>
          </p>
          <p className="text-body-sm text-muted-foreground">
            <Trans>
              Restoring imports new copies and never overwrites. Enter the same password here to
              restore keys. Leave it empty to export without keys.
            </Trans>
          </p>
        </div>
      </SettingsRow>
      {onImportAgent ? (
        <SettingsRow
          label={<Trans>Agent from another app</Trans>}
          control={
            <Button
              variant="secondary"
              size="sm"
              aria-label={t`Import an agent`}
              data-testid="agent-import-open"
              disabled={pending !== null}
              onClick={onImportAgent}
            >
              <Trans>Import</Trans>
            </Button>
          }
        />
      ) : null}
      {identityDialog}
    </>
  );
}
