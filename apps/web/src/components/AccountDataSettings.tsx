import { Trans, useLingui } from "@lingui/react/macro";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { Button, Spinner } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { recheckSessionOnUnauthorized, rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";

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

  async function exportData() {
    if (pending) return;
    setPending("export");
    setImported(false);
    setError(null);
    try {
      const { token } = await withIdentityConfirmation(() => rpc.export.accountToken());
      // A download link, not a fetch, so the browser or Electron saves the stream natively.
      const link = document.createElement("a");
      link.href = `/api/account/export?token=${encodeURIComponent(token)}`;
      link.download = "";
      link.click();
    } catch (cause) {
      if (!isIdentityConfirmationRequired(cause)) setError(errorText(cause, t`Could not continue`));
    } finally {
      setPending(null);
    }
  }

  async function importData(file: File) {
    if (pending) return;
    setPending("import");
    setImported(false);
    setError(null);
    try {
      const response = await fetch("/api/account/import", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        credentials: "include",
        body: file,
      });
      recheckSessionOnUnauthorized(response.status);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === "string" ? body.error : t`Could not continue`);
        return;
      }
      await onImported?.().catch(() => undefined);
      setImported(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="account-data">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={pending !== null}
          aria-busy={pending === "export"}
          onClick={() => void exportData()}
        >
          {pending === "export" ? <Spinner aria-hidden /> : null}
          <Trans>Export data</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={pending !== null}
          aria-busy={pending === "import"}
          onClick={() => fileInput.current?.click()}
        >
          {pending === "import" ? <Spinner aria-hidden /> : null}
          <Trans>Import data</Trans>
        </Button>
        {onImportAgent ? (
          <Button variant="outline" disabled={pending !== null} onClick={onImportAgent}>
            <Trans>Import an agent</Trans>
          </Button>
        ) : null}
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
        {imported ? <SuccessPop label={t`Done`} /> : null}
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      {identityDialog}
    </div>
  );
}
