import { Trans, useLingui } from "@lingui/react/macro";
import type { WorkforceStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthCapabilities } from "../lib/auth-capabilities";
import { rpc, withSpaceHeaders } from "../lib/rpc";

export function WorkforceOverlay({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const capabilities = useAuthCapabilities();
  const oauth = capabilities?.provider === "convex-company-os";
  const navigate = useNavigate();
  const [connection, setConnection] = useState<WorkforceStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [endpoint, setEndpoint] = useState("https://www.companyos.sh/api/mcp");
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [workers, setWorkers] = useState([
    {
      name: "Researcher",
      instructions: "Research the assigned question. Verify facts and cite sources.",
      model: "",
    },
  ]);
  async function request(method = "GET", body?: unknown) {
    const response = await fetch("/api/v1/workforce", {
      method,
      headers: withSpaceHeaders({ "content-type": "application/json" }),
      credentials: "include",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Workforce request failed");
    return result.connection as WorkforceStatus | null;
  }
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await request();
        if (!disposed) {
          setConnection(next);
          setLoaded(true);
        }
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : t`Could not load workforce`);
          setLoaded(true);
        }
      }
    };
    void refresh();
    void rpc.models
      .list()
      .then((catalog) => {
        if (!disposed)
          setModels(catalog.filter((m) => m.provider === "openrouter").map((m) => m.id));
      })
      .catch(() => {});
    const timer = setInterval(refresh, 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  async function save() {
    setPending(true);
    setError("");
    try {
      setConnection(
        await request("PUT", {
          endpoint: oauth ? `${capabilities.companyOsOrigin}/api/mcp` : endpoint,
          ...(!oauth && key ? { key } : {}),
          enabled: false,
          workers,
        }),
      );
      await onChanged?.();
      setKey("");
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Could not save workforce`);
    } finally {
      setPending(false);
    }
  }
  async function toggle() {
    if (!connection) return;
    setPending(true);
    setError("");
    try {
      setConnection(await request("PATCH", { enabled: !connection.enabled }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Could not update workforce`);
    } finally {
      setPending(false);
    }
  }
  const showForm = loaded && (!connection || editing);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] max-w-[calc(100%-2rem)] sm:max-w-2xl overflow-y-auto p-6 sm:p-8"
        showCloseButton={false}
      >
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>
            <Trans>Workforce</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close workforce`} />}
          >
            <X size={18} />
          </DialogClose>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!loaded ? (
          <p role="status">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {connection && !editing ? (
          <div className="space-y-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium">{connection.companyName}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {connection.lastError ||
                    (!connection.lastSyncedAt
                      ? t`Waiting for first sync`
                      : connection.enabled
                        ? t`Dispatch enabled`
                        : t`New assignments paused`)}
                </p>
              </div>
              <Button variant="outline" disabled={pending} onClick={toggle}>
                {connection.enabled ? t`Pause` : t`Resume`}
              </Button>
            </div>
            <div className="space-y-2">
              {connection.workers.map((worker) => (
                <button
                  key={worker.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 text-left hover:bg-muted"
                  onClick={() => {
                    navigate(`/app/${worker.id}`);
                    onClose();
                  }}
                >
                  <span>{worker.name}</span>
                  <span className="truncate text-sm text-muted-foreground">{worker.model}</span>
                </button>
              ))}
            </div>
            <div>
              <h3 className="mb-3 text-sm font-medium">
                <Trans>Company OS assignments</Trans>
              </h3>
              {connection.assignments.length ? (
                <div className="space-y-2">
                  {connection.assignments.map((assignment) => (
                    <div
                      key={assignment.id}
                      className="flex items-center justify-between gap-4 py-2 text-sm"
                    >
                      <span>#{assignment.seq}</span>
                      <span className="text-muted-foreground">
                        {assignment.status}
                        {assignment.synced ? ` · ${t`Synced`}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>Requests from your Company OS work queue will appear here.</Trans>
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              disabled={pending || connection.assignments.some((a) => !a.synced)}
              onClick={() => {
                setEndpoint(connection.endpoint);
                setWorkers(connection.workers.map((w) => ({ ...w, instructions: w.instructions })));
                setEditing(true);
              }}
            >
              <Trans>Edit workforce</Trans>
            </Button>
          </div>
        ) : null}
        {showForm ? (
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {oauth ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Your Company OS connection supplies the permissions for these workers.
                </Trans>
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Connect a Company OS agent key with context read and write access. Its
                    department permissions apply to every worker.
                  </Trans>
                </p>
                <label htmlFor="workforce-endpoint" className="block space-y-2 text-sm">
                  <span>
                    <Trans>Company OS endpoint</Trans>
                  </span>
                  <Input
                    id="workforce-endpoint"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    type="url"
                    required
                  />
                </label>
                <label htmlFor="workforce-key" className="block space-y-2 text-sm">
                  <span>
                    <Trans>Agent key</Trans>
                  </span>
                  <Input
                    id="workforce-key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    required={!connection}
                    placeholder={connection ? t`Leave blank to keep saved key` : ""}
                  />
                </label>
              </>
            )}
            <datalist id="workforce-models">
              {models.map((model) => (
                <option value={model} key={model} />
              ))}
            </datalist>
            <div className="space-y-6">
              {workers.map((worker, index) => (
                <fieldset key={index} className="space-y-3">
                  <legend className="mb-3 text-sm font-medium">
                    <Trans>Worker {index + 1}</Trans>
                  </legend>
                  <label htmlFor={`worker-name-${index}`} className="text-xs text-muted-foreground">
                    <Trans>Name</Trans>
                  </label>
                  <Input
                    id={`worker-name-${index}`}
                    aria-label={t`Worker name`}
                    value={worker.name}
                    required
                    maxLength={80}
                    onChange={(e) =>
                      setWorkers((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, name: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  <label
                    htmlFor={`worker-model-${index}`}
                    className="text-xs text-muted-foreground"
                  >
                    <Trans>OpenRouter model</Trans>
                  </label>
                  <Input
                    id={`worker-model-${index}`}
                    aria-label={t`OpenRouter model`}
                    list="workforce-models"
                    placeholder="provider/model"
                    value={worker.model}
                    required
                    onChange={(e) =>
                      setWorkers((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, model: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  <label
                    htmlFor={`worker-instructions-${index}`}
                    className="text-xs text-muted-foreground"
                  >
                    <Trans>Instructions</Trans>
                  </label>
                  <Textarea
                    id={`worker-instructions-${index}`}
                    rows={3}
                    aria-label={t`Worker instructions`}
                    value={worker.instructions}
                    onChange={(e) =>
                      setWorkers((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, instructions: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  {workers.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setWorkers((rows) => rows.filter((_, i) => i !== index))}
                    >
                      <Trans>Remove worker</Trans>
                    </Button>
                  ) : null}
                </fieldset>
              ))}
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={workers.length >= 8 || pending}
                onClick={() =>
                  setWorkers((rows) => [...rows, { name: "", instructions: "", model: "" }])
                }
              >
                <Trans>Add worker</Trans>
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t`Connecting…` : t`Connect workforce`}
              </Button>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
